import { createClient } from '@luxdb/sdk';
import type { Database } from '../types/lux';

if (!process.env.LUX_URL) throw new Error('LUX_URL not found in env');
if (!process.env.LUX_SECRET_KEY) throw new Error('LUX_SECRET_KEY not found in env');

export const lux = createClient<Database>(
    process.env.LUX_URL,
    process.env.LUX_SECRET_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    }
);
