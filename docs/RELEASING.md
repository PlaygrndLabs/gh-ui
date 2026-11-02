# Releasing GitHub UI

macOS releases must be Developer ID signed and notarized. Configure these GitHub Actions secrets before merging a release PR:

- `CSC_LINK`: base64-encoded `.p12` Developer ID Application certificate.
- `CSC_KEY_PASSWORD`: password for that certificate.
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect API key (`.p8`).
- `APPLE_API_KEY_ID`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer ID.

The release workflow signs, notarizes, and staples the app. It fails rather than publish an unsigned macOS build when a required secret is absent.
