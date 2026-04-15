/**
 * Supabase Client Configuration
 *
 * Creates and exports the Supabase client used across the API.
 * Uses the SERVICE ROLE key (not anon key) because this runs
 * server-side and needs full database access.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);
