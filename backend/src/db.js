import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';

// Node.js 20 не имеет встроенного WebSocket, а свежий supabase-js требует его
// даже для REST/RPC. Подставляем ws, чтобы не зависеть от версии Node на хостинге.
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
