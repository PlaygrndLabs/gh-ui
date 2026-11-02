const { notarize } = require('@electron/notarize')
const { execFileSync } = require('node:child_process')

exports.default = async function notarizeApp(context) {
  if (process.env.GITHUB_EVENT_NAME !== 'push') return

  for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    if (!process.env[name]) throw new Error(`Missing ${name}; release builds must be notarized.`)
  }

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  await notarize({
    tool: 'notarytool',
    appBundleId: context.packager.appInfo.id,
    appPath,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  })

  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
}
