const DEFAULT_SYNC_URL = 'http://localhost:8787'

const libreViewSyncUrl = (
  import.meta.env.VITE_LIBREVIEW_SYNC_URL as string | undefined
)?.replace(/\/+$/, '') || DEFAULT_SYNC_URL

interface SyncResult {
  success: boolean
  message?: string
  processed?: number
  uploaded?: number
}

export async function triggerLibreViewSync(): Promise<SyncResult> {
  const res = await fetch(`${libreViewSyncUrl}/sync`, { method: 'POST' })
  const json = await res.json().catch(() => null) as SyncResult | null

  if (!res.ok) {
    throw new Error(json?.message ?? `LibreView sync gaf HTTP ${res.status}`)
  }

  return json ?? { success: true }
}
