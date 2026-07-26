/**
 * Authentication module for the pantry registry.
 *
 * Provides:
 * - User signup / login with Argon2id password hashing (via Bun.password)
 * - API token generation with `ptry_` prefix for programmatic access
 * - Session management for web UI authentication
 * - In-memory and DynamoDB storage backends
 *
 * Security design:
 * - Passwords are hashed with Argon2id (Bun.password.hash)
 * - API tokens are stored as SHA-256 hashes (raw token shown only once at creation)
 * - Session tokens are stored as SHA-256 hashes
 * - All tokens use crypto.randomBytes(32) for generation (256-bit entropy)
 */

import * as crypto from 'node:crypto'
import type {
  ApiToken,
  ApiTokenInfo,
  AuthStorage,
  Session,
  TokenValidationResult,
  User,
} from './types'
import { effectiveTier, tierOf, type AccountSubscription, type Tier } from './subscriptions'
import { DynamoDBClient } from './storage/dynamodb-client'
import type { S3Client } from './storage/aws-client'
import { createS3Client, resolveStorageProvider } from './storage/provider'
import { ObjectSnapshot } from './storage/object-snapshot'

// ===========================================================================
// Token / Hash Helpers
// ===========================================================================

/** Prefix for API tokens — makes them easily identifiable */
const TOKEN_PREFIX = 'ptry_'

/** Generate a cryptographically random API token with the ptry_ prefix */
export function generateApiToken(): string {
  const raw = crypto.randomBytes(32).toString('hex')
  return `${TOKEN_PREFIX}${raw}`
}

/** Generate a cryptographically random session token */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Compute SHA-256 hex digest of a string */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Check whether a token string looks like a user API token */
export function isUserApiToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX)
}

// ===========================================================================
// Password Helpers (Bun.password — Argon2id)
// ===========================================================================

/** Hash a plaintext password using Argon2id */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

/** Verify a plaintext password against a stored hash */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
}

// ===========================================================================
// Auth Service — orchestrates auth operations
// ===========================================================================

export class AuthService {
  constructor(private storage: AuthStorage) {}

  /**
   * Register a new user account.
   * Returns the created user (without password hash).
   * Throws if email is already registered.
   */
  async signup(email: string, name: string, password: string): Promise<Omit<User, 'passwordHash'>> {
    const normalizedEmail = email.toLowerCase().trim()

    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new AuthError('Invalid email address', 400)
    }
    if (!name || name.trim().length === 0) {
      throw new AuthError('Name is required', 400)
    }
    if (!password || password.length < 8) {
      throw new AuthError('Password must be at least 8 characters', 400)
    }

    const existing = await this.storage.getUser(normalizedEmail)
    if (existing) {
      throw new AuthError('An account with this email already exists', 409)
    }

    const now = new Date().toISOString()
    const passwordHash = await hashPassword(password)

    const user: User = {
      email: normalizedEmail,
      name: name.trim(),
      passwordHash,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    }

    try {
      await this.storage.putUser(user)
    }
    catch (err: any) {
      if (err.message?.includes('ConditionalCheckFailed')) {
        throw new AuthError('An account with this email already exists', 409)
      }
      throw err
    }

    return { email: user.email, name: user.name, role: user.role || 'user', createdAt: user.createdAt, updatedAt: user.updatedAt }
  }

  /**
   * Create or update an admin account (production provisioning).
   */
  async upsertAdminUser(email: string, name: string, password: string): Promise<Omit<User, 'passwordHash'>> {
    return this.upsertUserAccount(email, name, password, 'admin')
  }

  /**
   * Create or update an account with an explicit role.
   *
   * This is how members are onboarded onto a private registry, where open
   * signup is off: the operator provisions the account, the member logs in and
   * mints their own tokens.
   */
  async upsertUserAccount(
    email: string,
    name: string,
    password: string,
    role: 'admin' | 'user' = 'user',
  ): Promise<Omit<User, 'passwordHash'>> {
    const normalizedEmail = email.toLowerCase().trim()
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new AuthError('Invalid email address', 400)
    }
    if (!password || password.length < 8) {
      throw new AuthError('Password must be at least 8 characters', 400)
    }

    const existing = await this.storage.getUser(normalizedEmail)
    const now = new Date().toISOString()
    const passwordHash = await hashPassword(password)
    const user: User = {
      email: normalizedEmail,
      name: (name || existing?.name || (role === 'admin' ? 'Admin' : normalizedEmail.split('@')[0])).trim(),
      passwordHash,
      role,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    await this.storage.upsertUser(user)
    return { email: user.email, name: user.name, role, createdAt: user.createdAt, updatedAt: user.updatedAt }
  }

  /**
   * Authenticate a user and create a web session.
   * Returns the raw session token (to be set as an HTTP-only cookie).
   */
  async login(email: string, password: string): Promise<{ sessionToken: string, user: Omit<User, 'passwordHash'> }> {
    const normalizedEmail = email.toLowerCase().trim()

    const user = await this.storage.getUser(normalizedEmail)
    if (!user) {
      // Perform dummy hash to prevent user enumeration via timing
      await hashPassword('dummy-password-for-timing-normalization')
      throw new AuthError('Invalid email or password', 401)
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) {
      throw new AuthError('Invalid email or password', 401)
    }

    // Create session (30-day expiry)
    const sessionToken = generateSessionToken()
    const session: Session = {
      tokenHash: hashToken(sessionToken),
      userId: user.email,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
    await this.storage.putSession(session)

    return {
      sessionToken,
      user: { email: user.email, name: user.name, role: user.role || 'user', createdAt: user.createdAt, updatedAt: user.updatedAt },
    }
  }

  /** Destroy a web session (logout). */
  async logout(sessionToken: string): Promise<void> {
    await this.storage.deleteSession(hashToken(sessionToken))
  }

  /** Validate a session token and return the associated user. */
  async validateSession(sessionToken: string): Promise<Omit<User, 'passwordHash'> | null> {
    const session = await this.storage.getSession(hashToken(sessionToken))
    if (!session) return null

    // Check expiry
    if (new Date(session.expiresAt) < new Date()) {
      await this.storage.deleteSession(session.tokenHash)
      return null
    }

    const user = await this.storage.getUser(session.userId)
    if (!user) return null

    return { email: user.email, name: user.name, role: user.role || 'user', createdAt: user.createdAt, updatedAt: user.updatedAt }
  }

  /**
   * Create a new API token for a user.
   * Returns the full token info INCLUDING the raw token string (shown only once).
   */
  async createApiToken(
    userId: string,
    name: string,
    options?: { permissions?: ('publish' | 'read')[], expiresInDays?: number },
  ): Promise<{ token: string, info: ApiTokenInfo }> {
    if (!name || name.trim().length === 0) {
      throw new AuthError('Token name is required', 400)
    }
    if (name.length > 255) {
      throw new AuthError('Token name must be 255 characters or fewer', 400)
    }

    const rawToken = generateApiToken()
    const now = new Date().toISOString()
    const expiresAt = options?.expiresInDays
      ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined

    const apiToken: ApiToken = {
      id: `${rawToken.slice(0, 8)}...${rawToken.slice(-4)}`,
      name: name.trim(),
      userId,
      tokenHash: hashToken(rawToken),
      permissions: options?.permissions || ['publish', 'read'],
      createdAt: now,
      expiresAt,
    }

    await this.storage.putApiToken(apiToken)

    return {
      token: rawToken,
      info: {
        id: apiToken.id,
        name: apiToken.name,
        permissions: apiToken.permissions,
        createdAt: apiToken.createdAt,
        expiresAt: apiToken.expiresAt,
      },
    }
  }

  /** List all API tokens for a user (without hashes). */
  async listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
    const tokens = await this.storage.listApiTokens(userId)
    return tokens.map(t => ({
      id: t.id,
      name: t.name,
      permissions: t.permissions,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
    }))
  }

  /** Delete an API token by its display ID. */
  async deleteApiToken(userId: string, tokenId: string): Promise<void> {
    await this.storage.deleteApiToken(userId, tokenId)
  }

  /**
   * Validate a Bearer token for publish operations.
   * Handles both legacy REGISTRY_TOKEN and user ptry_ tokens.
   */
  async validatePublishToken(token: string, legacyToken: string): Promise<TokenValidationResult> {
    return this.validateAccessToken(token, legacyToken, 'publish')
  }

  /**
   * Validate a Bearer token for a given permission.
   *
   * `publish` implies `read`: a CI token that uploads a version also needs to
   * ask the registry which versions already exist, and issuing two tokens for
   * one pipeline is friction with no security benefit. A `read` token, on the
   * other hand, can only download — which is exactly what you hand to a
   * consumer of a private registry.
   */
  async validateAccessToken(
    token: string,
    legacyToken: string,
    permission: 'publish' | 'read',
  ): Promise<TokenValidationResult> {
    // Legacy admin token check (constant-time comparison to prevent timing attacks)
    if (legacyToken) {
      // Pad both to same length to prevent length-based timing leaks
      const maxLen = Math.max(token.length, legacyToken.length)
      const tokenBuf = Buffer.alloc(maxLen)
      const legacyBuf = Buffer.alloc(maxLen)
      Buffer.from(token).copy(tokenBuf)
      Buffer.from(legacyToken).copy(legacyBuf)
      if (crypto.timingSafeEqual(tokenBuf, legacyBuf) && token.length === legacyToken.length) {
        return { valid: true, userId: '_admin' }
      }
    }

    // User API token
    if (isUserApiToken(token)) {
      const tokenRecord = await this.storage.getApiTokenByHash(hashToken(token))
      if (!tokenRecord) {
        return { valid: false, error: 'Invalid token' }
      }

      // Check expiry
      if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) < new Date()) {
        return { valid: false, error: 'Token has expired' }
      }

      const permitted = permission === 'read'
        ? tokenRecord.permissions.includes('read') || tokenRecord.permissions.includes('publish')
        : tokenRecord.permissions.includes('publish')
      if (!permitted) {
        return { valid: false, error: `Token does not have ${permission} permission` }
      }

      // Update last-used timestamp (fire-and-forget)
      this.storage.updateTokenLastUsed(tokenRecord.tokenHash).catch(err => console.warn('Failed to update token last-used:', err))

      return { valid: true, userId: tokenRecord.userId, tokenId: tokenRecord.id }
    }

    // Not a recognized token format
    return { valid: false, error: 'Invalid token' }
  }

  /** Look up a user without exposing the password hash. Null when unknown. */
  async findUser(email: string): Promise<Omit<User, 'passwordHash'> | null> {
    const user = await this.storage.getUser(email.toLowerCase().trim())
    if (!user) return null
    return {
      email: user.email,
      name: user.name,
      role: user.role || 'user',
      subscription: user.subscription,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }
  }

  /** The stored subscription for an account, or null when it is on Free. */
  async getSubscription(email: string): Promise<AccountSubscription | null> {
    const user = await this.storage.getUser(email.toLowerCase().trim())
    if (!user?.subscription) return null
    return {
      tier: tierOf(user.subscription.tier),
      status: (user.subscription.status || 'none') as AccountSubscription['status'],
      stripeCustomerId: user.subscription.stripeCustomerId,
      stripeSubscriptionId: user.subscription.stripeSubscriptionId,
      currentPeriodEnd: user.subscription.currentPeriodEnd,
      updatedAt: user.subscription.updatedAt,
    }
  }

  /**
   * The tier an account is entitled to right now, which is not the same as the
   * tier it is billed for: a failed payment keeps its benefits while Stripe
   * retries, and a cancellation keeps them until the paid period ends.
   */
  async getTier(email: string | null | undefined): Promise<Tier> {
    if (!email || email === '_admin') return 'free'
    return effectiveTier(await this.getSubscription(email))
  }

  /**
   * Record what Stripe says about a subscription.
   *
   * Read-modify-write on the whole user rather than a field update, because
   * that is the only operation every storage backend has in common. The write
   * is small and subscription changes are rare, so the race window is
   * theoretical — and Stripe is the source of truth either way, so a lost
   * update is corrected by the next webhook.
   */
  async setSubscription(email: string, sub: AccountSubscription | null): Promise<void> {
    const normalized = email.toLowerCase().trim()
    const user = await this.storage.getUser(normalized)
    if (!user) throw new AuthError(`No such account: ${email}`, 404)

    const next: User = {
      ...user,
      updatedAt: new Date().toISOString(),
    }

    if (!sub || sub.tier === 'free') {
      delete next.subscription
    }
    else {
      next.subscription = {
        tier: sub.tier,
        status: sub.status,
        stripeCustomerId: sub.stripeCustomerId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        currentPeriodEnd: sub.currentPeriodEnd,
        updatedAt: new Date().toISOString(),
      }
    }

    await this.storage.upsertUser(next)
  }

  // -------------------------------------------------------------------------
  // Teams
  //
  // A seat holder shares their packages with members: the members can publish
  // new versions, price them and see their analytics, and the *owner's* plan
  // governs the commission and the limits. Membership is stored on both sides
  // — the roster on the owner, a back-pointer on the member — so "may this
  // account publish this package?" is one lookup on the hot publish path.
  // -------------------------------------------------------------------------

  /** The member roster for a seat holder. Empty when they have no team. */
  async getTeamMembers(owner: string): Promise<string[]> {
    const user = await this.storage.getUser(owner.toLowerCase().trim())
    return user?.team?.members ?? []
  }

  /** The seat holder this account belongs to, if any. */
  async getTeamOwner(email: string): Promise<string | null> {
    const user = await this.storage.getUser(email.toLowerCase().trim())
    return user?.teamOwner ?? null
  }

  /**
   * Whether `actor` may act on things owned by `owner` — the same account, or
   * one of its team members.
   */
  async canActFor(actor: string | null | undefined, owner: string | null | undefined): Promise<boolean> {
    if (!actor || !owner) return false
    const a = actor.toLowerCase().trim()
    const o = owner.toLowerCase().trim()
    if (a === o) return true
    return (await this.getTeamOwner(a)) === o
  }

  /**
   * Add a member to a seat holder's team.
   *
   * `seatLimit` counts the owner, so a 10-seat plan invites 9 people. Callers
   * pass it from the tier table rather than this module reading plans, which
   * keeps billing policy in one place.
   */
  async addTeamMember(owner: string, memberEmail: string, seatLimit: number): Promise<string[]> {
    const ownerEmail = owner.toLowerCase().trim()
    const member = memberEmail.toLowerCase().trim()

    if (member === ownerEmail)
      throw new AuthError('You are already on your own team', 400)

    const ownerUser = await this.storage.getUser(ownerEmail)
    if (!ownerUser) throw new AuthError('No such account', 404)

    const memberUser = await this.storage.getUser(member)
    if (!memberUser)
      throw new AuthError(`${memberEmail} does not have an account yet — they need to sign up first`, 404)

    // One team per account: being on two would make "whose plan applies?"
    // ambiguous on every publish.
    if (memberUser.teamOwner && memberUser.teamOwner !== ownerEmail)
      throw new AuthError(`${memberEmail} is already on another team`, 409)
    if (memberUser.team?.members?.length)
      throw new AuthError(`${memberEmail} runs their own team`, 409)

    const members = ownerUser.team?.members ?? []
    if (members.includes(member)) return members

    if (members.length + 1 >= seatLimit)
      throw new AuthError(`That plan includes ${seatLimit} seats, and they are all taken`, 402)

    const next = [...members, member]
    await this.storage.upsertUser({
      ...ownerUser,
      team: { members: next, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    })
    await this.storage.upsertUser({
      ...memberUser,
      teamOwner: ownerEmail,
      updatedAt: new Date().toISOString(),
    })

    return next
  }

  /** Remove a member. Their own packages are untouched — only the sharing ends. */
  async removeTeamMember(owner: string, memberEmail: string): Promise<string[]> {
    const ownerEmail = owner.toLowerCase().trim()
    const member = memberEmail.toLowerCase().trim()

    const ownerUser = await this.storage.getUser(ownerEmail)
    if (!ownerUser) throw new AuthError('No such account', 404)

    const next = (ownerUser.team?.members ?? []).filter(m => m !== member)
    await this.storage.upsertUser({
      ...ownerUser,
      team: { members: next, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    })

    const memberUser = await this.storage.getUser(member)
    if (memberUser?.teamOwner === ownerEmail) {
      const cleaned: User = { ...memberUser, updatedAt: new Date().toISOString() }
      delete cleaned.teamOwner
      await this.storage.upsertUser(cleaned)
    }

    return next
  }

  /** Find the account a Stripe customer belongs to, for webhook handling. */
  async findByStripeCustomer(customerId: string, candidateEmail?: string): Promise<string | null> {
    // Stripe sends the customer's email on the events we care about, so a
    // lookup by email confirms the mapping without needing a second index.
    if (candidateEmail) {
      const sub = await this.getSubscription(candidateEmail)
      if (sub?.stripeCustomerId === customerId || !sub?.stripeCustomerId) {
        const user = await this.storage.getUser(candidateEmail.toLowerCase().trim())
        if (user) return user.email
      }
    }
    return null
  }
}

// ===========================================================================
// Auth Error
// ===========================================================================

export class AuthError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

// ===========================================================================
// In-Memory Auth Storage (development / testing)
// ===========================================================================

export class InMemoryAuthStorage implements AuthStorage {
  private users = new Map<string, User>()
  private apiTokensByHash = new Map<string, ApiToken>()
  private apiTokensByUser = new Map<string, ApiToken[]>()
  private sessions = new Map<string, Session>()

  async getUser(email: string): Promise<User | null> {
    return this.users.get(email.toLowerCase()) || null
  }

  async putUser(user: User): Promise<void> {
    this.users.set(user.email.toLowerCase(), user)
    this.onMutate()
  }

  async upsertUser(user: User): Promise<void> {
    this.users.set(user.email.toLowerCase(), user)
    this.onMutate()
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.getUser(email)
  }

  async putApiToken(token: ApiToken): Promise<void> {
    this.apiTokensByHash.set(token.tokenHash, token)
    const userTokens = this.apiTokensByUser.get(token.userId) || []
    userTokens.push(token)
    this.apiTokensByUser.set(token.userId, userTokens)
    this.onMutate()
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    return this.apiTokensByHash.get(tokenHash) || null
  }

  async listApiTokens(userId: string): Promise<ApiToken[]> {
    return this.apiTokensByUser.get(userId) || []
  }

  async deleteApiToken(userId: string, tokenId: string): Promise<void> {
    const tokens = this.apiTokensByUser.get(userId) || []
    const tokenToDelete = tokens.find(t => t.id === tokenId)
    if (tokenToDelete) {
      this.apiTokensByHash.delete(tokenToDelete.tokenHash)
      this.apiTokensByUser.set(userId, tokens.filter(t => t.id !== tokenId))
      this.onMutate()
    }
  }

  async updateTokenLastUsed(tokenHash: string): Promise<void> {
    const token = this.apiTokensByHash.get(tokenHash)
    if (token) {
      token.lastUsedAt = new Date().toISOString()
      this.onMutate()
    }
  }

  async putSession(session: Session): Promise<void> {
    this.sessions.set(session.tokenHash, session)
    this.onMutate()
  }

  async getSession(tokenHash: string): Promise<Session | null> {
    return this.sessions.get(tokenHash) || null
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash)
    this.onMutate()
  }

  /** Persistence hook — overridden by ObjectAuthStorage to snapshot to the bucket. */
  protected onMutate(): void {}

  protected captureState(): { users: Record<string, User>, apiTokens: ApiToken[], sessions: Record<string, Session> } {
    return {
      users: Object.fromEntries(this.users),
      apiTokens: [...this.apiTokensByHash.values()],
      sessions: Object.fromEntries(this.sessions),
    }
  }

  protected applyState(data: { users?: Record<string, User>, apiTokens?: ApiToken[], sessions?: Record<string, Session> }): void {
    if (data?.users)
      this.users = new Map(Object.entries(data.users))
    if (data?.sessions)
      this.sessions = new Map(Object.entries(data.sessions))
    if (data?.apiTokens) {
      this.apiTokensByHash = new Map()
      this.apiTokensByUser = new Map()
      for (const t of data.apiTokens) {
        this.apiTokensByHash.set(t.tokenHash, t)
        const list = this.apiTokensByUser.get(t.userId) || []
        list.push(t)
        this.apiTokensByUser.set(t.userId, list)
      }
    }
  }
}

// ===========================================================================
// DynamoDB Auth Storage (production)
//
// Single-table design keys:
//   USER#{email}          / PROFILE           — user account
//   USER#{email}          / API_TOKEN#{id}    — API token metadata
//   TOKEN_HASH#{hash}     / METADATA          — reverse lookup for token validation
//   SESSION#{hash}        / METADATA          — web session
// ===========================================================================

export class DynamoDBAuthStorage implements AuthStorage {
  private db: DynamoDBClient
  private tableName: string

  constructor(tableName: string, region = 'us-east-1') {
    this.tableName = tableName
    this.db = new DynamoDBClient(region)
  }

  async getUser(email: string): Promise<User | null> {
    const result = await this.db.getItem({
      TableName: this.tableName,
      Key: {
        PK: { S: `USER#${email.toLowerCase()}` },
        SK: { S: 'PROFILE' },
      },
    })

    if (!result.Item) return null
    const data = DynamoDBClient.unmarshal(result.Item)
    return {
      email: data.email,
      name: data.name,
      passwordHash: data.passwordHash,
      role: data.role === 'admin' ? 'admin' : 'user',
      // Stored as JSON: the shape is Stripe's to change, and a nested map here
      // would mean a marshalling change every time it does.
      ...(data.subscription ? { subscription: JSON.parse(data.subscription) } : {}),
      ...(data.team ? { team: JSON.parse(data.team) } : {}),
      ...(data.teamOwner ? { teamOwner: data.teamOwner } : {}),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    }
  }

  async putUser(user: User): Promise<void> {
    await this.db.putItem({
      TableName: this.tableName,
      Item: DynamoDBClient.marshal({
        PK: `USER#${user.email.toLowerCase()}`,
        SK: 'PROFILE',
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.role || 'user',
        ...(user.subscription ? { subscription: JSON.stringify(user.subscription) } : {}),
        ...(user.team ? { team: JSON.stringify(user.team) } : {}),
        ...(user.teamOwner ? { teamOwner: user.teamOwner } : {}),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }),
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  }

  async upsertUser(user: User): Promise<void> {
    await this.db.putItem({
      TableName: this.tableName,
      Item: DynamoDBClient.marshal({
        PK: `USER#${user.email.toLowerCase()}`,
        SK: 'PROFILE',
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.role || 'user',
        ...(user.subscription ? { subscription: JSON.stringify(user.subscription) } : {}),
        ...(user.team ? { team: JSON.stringify(user.team) } : {}),
        ...(user.teamOwner ? { teamOwner: user.teamOwner } : {}),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }),
    })
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.getUser(email)
  }

  async putApiToken(token: ApiToken): Promise<void> {
    // Store under user key for listing
    await this.db.putItem({
      TableName: this.tableName,
      Item: DynamoDBClient.marshal({
        PK: `USER#${token.userId}`,
        SK: `API_TOKEN#${token.id}`,
        id: token.id,
        name: token.name,
        userId: token.userId,
        tokenHash: token.tokenHash,
        permissions: token.permissions,
        createdAt: token.createdAt,
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      }),
    })

    // Store reverse lookup by hash for fast validation
    await this.db.putItem({
      TableName: this.tableName,
      Item: DynamoDBClient.marshal({
        PK: `TOKEN_HASH#${token.tokenHash}`,
        SK: 'METADATA',
        id: token.id,
        name: token.name,
        userId: token.userId,
        tokenHash: token.tokenHash,
        permissions: token.permissions,
        createdAt: token.createdAt,
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      }),
    })
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    const result = await this.db.getItem({
      TableName: this.tableName,
      Key: {
        PK: { S: `TOKEN_HASH#${tokenHash}` },
        SK: { S: 'METADATA' },
      },
    })

    if (!result.Item) return null
    const data = DynamoDBClient.unmarshal(result.Item)
    return {
      id: data.id,
      name: data.name,
      userId: data.userId,
      tokenHash: data.tokenHash,
      permissions: data.permissions || ['publish', 'read'],
      createdAt: data.createdAt,
      lastUsedAt: data.lastUsedAt || undefined,
      expiresAt: data.expiresAt || undefined,
    }
  }

  async listApiTokens(userId: string): Promise<ApiToken[]> {
    const result = await this.db.query({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'API_TOKEN#' },
      },
    })

    return result.Items.map((item) => {
      const data = DynamoDBClient.unmarshal(item)
      return {
        id: data.id,
        name: data.name,
        userId: data.userId,
        tokenHash: data.tokenHash,
        permissions: data.permissions || ['publish', 'read'],
        createdAt: data.createdAt,
        lastUsedAt: data.lastUsedAt || undefined,
        expiresAt: data.expiresAt || undefined,
      }
    })
  }

  async deleteApiToken(userId: string, tokenId: string): Promise<void> {
    // Get the token first to find its hash (needed for reverse lookup cleanup)
    const result = await this.db.getItem({
      TableName: this.tableName,
      Key: {
        PK: { S: `USER#${userId}` },
        SK: { S: `API_TOKEN#${tokenId}` },
      },
    })

    if (result.Item) {
      const data = DynamoDBClient.unmarshal(result.Item)

      // Delete reverse lookup first — disables token authentication immediately.
      // If the process crashes after this but before deleting the user record,
      // the token appears in the user's list but can no longer authenticate (safe).
      if (data.tokenHash) {
        await this.db.deleteItem({
          TableName: this.tableName,
          Key: {
            PK: { S: `TOKEN_HASH#${data.tokenHash}` },
            SK: { S: 'METADATA' },
          },
        })
      }

      // Delete user record
      await this.db.deleteItem({
        TableName: this.tableName,
        Key: {
          PK: { S: `USER#${userId}` },
          SK: { S: `API_TOKEN#${tokenId}` },
        },
      })
    }
  }

  async updateTokenLastUsed(tokenHash: string): Promise<void> {
    const now = new Date().toISOString()

    // Update reverse lookup record
    await this.db.updateItem({
      TableName: this.tableName,
      Key: {
        PK: { S: `TOKEN_HASH#${tokenHash}` },
        SK: { S: 'METADATA' },
      },
      UpdateExpression: 'SET lastUsedAt = :now',
      ExpressionAttributeValues: {
        ':now': { S: now },
      },
    })
  }

  async putSession(session: Session): Promise<void> {
    await this.db.putItem({
      TableName: this.tableName,
      Item: DynamoDBClient.marshal({
        PK: `SESSION#${session.tokenHash}`,
        SK: 'METADATA',
        tokenHash: session.tokenHash,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      }),
    })
  }

  async getSession(tokenHash: string): Promise<Session | null> {
    const result = await this.db.getItem({
      TableName: this.tableName,
      Key: {
        PK: { S: `SESSION#${tokenHash}` },
        SK: { S: 'METADATA' },
      },
    })

    if (!result.Item) return null
    const data = DynamoDBClient.unmarshal(result.Item)

    // Check expiry
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      // Expired — clean up
      await this.deleteSession(tokenHash)
      return null
    }

    return {
      tokenHash: data.tokenHash,
      userId: data.userId,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
    }
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.deleteItem({
      TableName: this.tableName,
      Key: {
        PK: { S: `SESSION#${tokenHash}` },
        SK: { S: 'METADATA' },
      },
    })
  }
}

// ===========================================================================
// Factory
// ===========================================================================

/**
 * Object-storage-backed auth storage (Hetzner / Backblaze B2 / S3).
 *
 * Users, API tokens and sessions are kept in memory and persisted as a single
 * JSON snapshot in the bucket — the same model as ObjectMetadataStorage — so
 * the registry's auth runs fully off DynamoDB.
 */
export class ObjectAuthStorage extends InMemoryAuthStorage {
  private snapshot: ObjectSnapshot
  private loaded: Promise<void>

  constructor(opts: { s3: S3Client, bucket: string, key?: string }) {
    super()
    this.snapshot = new ObjectSnapshot(
      opts.s3,
      opts.bucket,
      opts.key || 'auth/registry-auth.json',
      () => this.captureState(),
    )
    this.loaded = this.snapshot.load().then((data) => {
      if (data)
        this.applyState(data as { users?: Record<string, User>, apiTokens?: ApiToken[], sessions?: Record<string, Session> })
    })
  }

  /** Resolves once the initial snapshot has loaded — await on boot before serving reads. */
  ready(): Promise<void> {
    return this.loaded
  }

  protected onMutate(): void {
    this.snapshot.scheduleSave()
  }

  /** Flush any pending save immediately (e.g. before shutdown). */
  async flush(): Promise<void> {
    await this.snapshot.flush()
  }
}

/**
 * Create an AuthStorage instance based on the environment.
 *
 * Non-AWS providers (Hetzner / B2) persist auth as a bucket JSON snapshot — no
 * DynamoDB. AWS keeps the DynamoDB-backed store when a table is configured.
 * Falls back to in-memory for local dev.
 */
export function createAuthStorage(tableName?: string, region?: string): AuthStorage {
  const bucket = process.env.S3_BUCKET
  const provider = resolveStorageProvider()

  if (provider.provider !== 'aws' && bucket && bucket !== 'local')
    return new ObjectAuthStorage({ s3: createS3Client(provider), bucket })

  const table = tableName || process.env.DYNAMODB_TABLE || 'local'
  if (table && table !== 'local')
    return new DynamoDBAuthStorage(table, region || process.env.AWS_REGION || 'us-east-1')

  return new InMemoryAuthStorage()
}
