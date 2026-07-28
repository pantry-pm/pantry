export interface ActionInputs {
  version: string
  packages: string
  services: string
  configPath: string
  setupOnly: boolean
  publish: string
  packageDir: string
  registryUrl: string
  token: string
  discordWebhook: string
  slackWebhook: string
  notificationTitle: string
  notificationMentions: string
  release: boolean
  releaseFiles: string
  releaseTag: string
  releaseMakeLatest: string
  releaseDraft: boolean
  releasePrerelease: boolean
  releaseNotes: string
  releaseChangelog: string
  releaseChecksums: string
  releaseToken: string
  releaseDryRun: boolean
  releaseAppStore: boolean
  releaseAppStorePackage: string
  releaseAppStoreApiKeyId: string
  releaseAppStoreIssuerId: string
  releaseAppStorePrivateKey: string
  releaseAppStoreValidateOnly: boolean
  releaseAppStoreRetryExisting: boolean
  releaseS3: boolean
  releaseS3Provider: 'aws' | 'backblaze' | 'hetzner'
  releaseS3Bucket: string
  releaseS3Region: string
  releaseS3Endpoint: string
  releaseS3Prefix: string
  releaseS3PublicUrl: string
  releaseS3ForcePathStyle: boolean
  releaseS3CacheControl: string
  releaseS3AccessKeyId: string
  releaseS3SecretAccessKey: string
  releaseS3SessionToken: string
}

export interface Platform {
  os: 'darwin' | 'linux' | 'windows'
  arch: 'x64' | 'arm64'
  binaryName: string
  assetName: string
}
