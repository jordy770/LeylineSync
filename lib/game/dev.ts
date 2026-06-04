export const showDevControls = process.env.NEXT_PUBLIC_SHOW_DEV_CONTROLS === 'true'

export const enableFallbackRefresh =
  process.env.NEXT_PUBLIC_ENABLE_FALLBACK_REFRESH !== 'false'

export const fallbackRefreshIntervalMs = Number(
  process.env.NEXT_PUBLIC_FALLBACK_REFRESH_MS ?? 2000,
)
