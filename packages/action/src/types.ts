export interface ActionInputs {
  version: string
  packages: string
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
}

export interface Platform {
  os: 'darwin' | 'linux' | 'windows'
  arch: 'x64' | 'arm64'
  binaryName: string
  assetName: string
}
