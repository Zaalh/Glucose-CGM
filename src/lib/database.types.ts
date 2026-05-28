export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      glucose_readings: {
        Row: {
          id: string
          timestamp: string
          value_mmol: number
          trend: string | null
          source: string
          raw_value: number | null
          unit: string
          created_at: string
        }
        Insert: {
          id?: string
          timestamp: string
          value_mmol: number
          trend?: string | null
          source: string
          raw_value?: number | null
          unit?: string
          created_at?: string
        }
        Update: {
          id?: string
          timestamp?: string
          value_mmol?: number
          trend?: string | null
          source?: string
          raw_value?: number | null
          unit?: string
          created_at?: string
        }
      }
      alert_rules: {
        Row: {
          id: string
          name: string
          threshold_low: number | null
          threshold_high: number | null
          enabled: boolean
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          threshold_low?: number | null
          threshold_high?: number | null
          enabled?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          threshold_low?: number | null
          threshold_high?: number | null
          enabled?: boolean
          created_at?: string
        }
      }
    }
  }
}
