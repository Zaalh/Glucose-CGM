import { createClient } from '@supabase/supabase-js'

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || 'http://127.0.0.1:54321'
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'local-placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
