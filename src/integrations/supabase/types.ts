export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      chartability_ratings: {
        Row: {
          colour_count: number | null
          dims: string | null
          generated_at: string | null
          id: string
          label: string
          motif_class: string | null
          notes: string | null
          prompt: string | null
          rated_at: string
          signals: Json
          updated_at: string
          user_id: string
          verdict: string
        }
        Insert: {
          colour_count?: number | null
          dims?: string | null
          generated_at?: string | null
          id?: string
          label: string
          motif_class?: string | null
          notes?: string | null
          prompt?: string | null
          rated_at?: string
          signals?: Json
          updated_at?: string
          user_id: string
          verdict: string
        }
        Update: {
          colour_count?: number | null
          dims?: string | null
          generated_at?: string | null
          id?: string
          label?: string
          motif_class?: string | null
          notes?: string | null
          prompt?: string | null
          rated_at?: string
          signals?: Json
          updated_at?: string
          user_id?: string
          verdict?: string
        }
        Relationships: []
      }
      corpus_cells: {
        Row: {
          col: number | null
          gw: number | null
          label: string | null
          r: number | null
          val: number | null
          verdict: string | null
        }
        Insert: {
          col?: number | null
          gw?: number | null
          label?: string | null
          r?: number | null
          val?: number | null
          verdict?: string | null
        }
        Update: {
          col?: number | null
          gw?: number | null
          label?: string | null
          r?: number | null
          val?: number | null
          verdict?: string | null
        }
        Relationships: []
      }
      corpus_grids: {
        Row: {
          capture: string | null
          gh: number | null
          grid: Json | null
          gw: number | null
          intentionally_asym: boolean | null
          label: string
          palette: Json | null
          sym_flagged: boolean | null
          verdict: string | null
        }
        Insert: {
          capture?: string | null
          gh?: number | null
          grid?: Json | null
          gw?: number | null
          intentionally_asym?: boolean | null
          label: string
          palette?: Json | null
          sym_flagged?: boolean | null
          verdict?: string | null
        }
        Update: {
          capture?: string | null
          gh?: number | null
          grid?: Json | null
          gw?: number | null
          intentionally_asym?: boolean | null
          label?: string
          palette?: Json | null
          sym_flagged?: boolean | null
          verdict?: string | null
        }
        Relationships: []
      }
      designs: {
        Row: {
          chart_data: Json | null
          created_at: string
          design_meta: Json
          id: string
          name: string
          stitch_progress: string | null
          thumbnail_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          chart_data?: Json | null
          created_at?: string
          design_meta?: Json
          id?: string
          name: string
          stitch_progress?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          chart_data?: Json | null
          created_at?: string
          design_meta?: Json
          id?: string
          name?: string
          stitch_progress?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      motifs: {
        Row: {
          brand: string
          cells: Json
          created_at: string
          height: number
          id: string
          name: string
          thumbnail_url: string | null
          updated_at: string
          user_id: string | null
          width: number
        }
        Insert: {
          brand: string
          cells: Json
          created_at?: string
          height: number
          id?: string
          name: string
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string | null
          width: number
        }
        Update: {
          brand?: string
          cells?: Json
          created_at?: string
          height?: number
          id?: string
          name?: string
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string | null
          width?: number
        }
        Relationships: []
      }
      orders: {
        Row: {
          created_at: string
          design_id: string
          id: string
          order_details: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          design_id: string
          id?: string
          order_details?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          design_id?: string
          id?: string
          order_details?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_design_id_fkey"
            columns: ["design_id"]
            isOneToOne: false
            referencedRelation: "designs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      thread_stash: {
        Row: {
          brand: string
          code: string
          created_at: string
          id: string
          location: string | null
          name: string | null
          quantity: number
          unit: string
          updated_at: string
          user_id: string
        }
        Insert: {
          brand: string
          code: string
          created_at?: string
          id?: string
          location?: string | null
          name?: string | null
          quantity?: number
          unit?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          brand?: string
          code?: string
          created_at?: string
          id?: string
          location?: string | null
          name?: string | null
          quantity?: number
          unit?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
