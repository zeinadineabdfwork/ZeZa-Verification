require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const path = require('path');

// ============================================================================
// SERVIDOR WEB + API REST
// ============================================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

app.get('/config', (req, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Endpoint para ativar/desativar monitor
app.post('/api/monitors/:employeeId/toggle', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { action } = req.body; // 'start' ou 'stop'

    const monitor = orchestrator.monitors.find(m => m.config.employeeId === employeeId);

    if (!monitor) {
      // Monitor não existe, buscar no banco e criar
      const { data: account } = await supabase
        .from('email_accounts')
        .select('*')
        .eq('employee_id', employeeId)
        .single();

      if (!account) {
        return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      }

      if (action === 'start') {
        await orchestrator.addMonitor({
          user: account.email,
          pass: account.password_app,
          employeeId: account.employee_id
        });

        return res.json({ 
          success: true, 
          message: 'Monitor iniciado',
          status: 'active'
        });
      }
    } else {
      // Monitor existe
      if (action === 'stop') {
        await monitor.stop();
        orchestrator.monitors = orchestrator.monitors.filter(m => m.config.employeeId !== employeeId);
        
        return res.json({ 
          success: true, 
          message: 'Monitor parado',
          status: 'inactive'
        });
      } else if (action === 'start') {
        // Já está ativo
        return res.json({ 
          success: true, 
          message: 'Monitor já está ativo',
          status: 'active'
        });
      }
    }

    res.status(400).json({ success: false, error: 'Ação inválida' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint para status em tempo real
app.get('/api/monitors/status', (req, res) => {
  const status = orchestrator.monitors.map(m => ({
    employeeId: m.config.employeeId,
    email: m.config.user,
    status: m.client?.authenticated ? 'active' : 'connecting',
    processedCount: m.processedUIDs.size,
    reconnectAttempts: m.reconnectAttempts,
    cleanupDone: m.initialCleanupDone
  }));
  
  res.json({ success: true, monitors: status });
});

app.get('/api/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_accounts')
      .select('id, employee_id, employee_name, email, status, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { employee_name, email, password_app } = req.body;

    if (!employee_name || !email || !password_app) {
      return res.status(400).json({ 
        success: false, 
        error: 'Todos os campos são obrigatórios' 
      });
    }

    const employee_id = `EMP${Date.now().toString().slice(-6)}`;

    const { data, error } = await supabase
      .from('email_accounts')
      .insert([{
        employee_id,
        employee_name,
        email,
        password_app
      }])
      .select();

    if (error) throw error;

    console.log(`✅ Nova conta: ${employee_id} - ${email}`);

    await orchestrator.addMonitor({
      user: email,
      pass: password_app,
      employeeId: employee_id
    });

    res.json({ 
      success: true, 
      message: 'Conta cadastrada!',
      data: data[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('email_accounts')
      .delete()
      .eq('id', id);

    if (error) throw error;

    console.log(`🗑️  Conta deletada: ${id}`);
    res.json({ success: true, message: 'Deletada' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🌐 Dashboard: http://localhost:${PORT}\n`);
});

// ============================================================================
// VALIDAÇÃO
// ============================================================================
const requiredVars = ['SUPABASE_URL', 'SUPABASE_KEY'];
const missing = requiredVars.filter(v => !process.env[v]);

if (missing.length > 0) {
  console.error('❌ Faltam variáveis:', missing.join(', '));
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================
const ALLOWED_SENDERS = [
  'facebookmail.com',
  'google.com',
  'instagram.com',
  'tiktok.com',
  'gmail.com',
  'simo.co.mz'
];

const CODE_REGEX = /\b(\d{6,8})\b/g;
const SECURITY_KEYWORD = process.env.SECURITY_KEYWORD || '3DS';

console.log(`🔒 Palavra-chave: "${SECURITY_KEYWORD}"`);
console.log(`💡 Só processa e-mails com essa palavra\n`);

// ============================================================================
// MONITOR DE E-MAIL
// ============================================================================
class EmailMonitor {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.reconnectAttempts = 0;
    this.processedUIDs = new Map();
    this.cleanupInterval = null;
    this.startTime = Date.now();
    this.initialCleanupDone = false;
    this.status = 'inactive'; // inactive, connecting, active, error
  }

  async start() {
    console.log(`[${this.config.employeeId}] 🚀 INICIANDO MANUALMENTE`);
    console.log(`[${this.config.employeeId}] 🔑 Senha: ${this.config.pass?.substring(0, 4)}...${this.config.pass?.slice(-4)}`);
    
    try {
      this.status = 'connecting';
      await this.connect();
      await this.listen();
      this.startCleanup();
      this.status = 'active';
      console.log(`[${this.config.employeeId}] ✅ ATIVO E PRONTO!\n`);
    } catch (error) {
      this.status = 'error';
      console.error(`[${this.config.employeeId}] ❌ Erro:`, error.message);
      this.reconnect();
    }
  }

  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      
      for (const [uid, timestamp] of this.processedUIDs.entries()) {
        if (timestamp < fiveMinutesAgo) {
          this.processedUIDs.delete(uid);
        }
      }
      
      console.log(`[${this.config.employeeId}] 🧹 Cache: ${this.processedUIDs.size} UIDs`);
    }, 5 * 60 * 1000);
  }

  async connect() {
    try {
      console.log(`[${this.config.employeeId}] 🔌 Conectando...`);
      
      this.client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { 
          user: this.config.user, 
          pass: this.config.pass 
        },
        logger: false,
        // Configurações anti-timeout
        socketTimeout: 120000,   // 2 minutos
        greetingTimeout: 30000,  // 30 segundos
        connectionTimeout: 30000 // 30 segundos
      });

      this.client.on('error', (err) => {
        console.error(`[${this.config.employeeId}] ❌ Erro:`, err.message);
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
          console.log(`[${this.config.employeeId}] 🔄 Reconexão por timeout...`);
        }
        this.reconnect();
      });

      this.client.on('close', () => {
        console.log(`[${this.config.employeeId}] 🔌 Desconectado`);
        this.reconnect();
      });

      await this.client.connect();
      this.reconnectAttempts = 0;
      console.log(`[${this.config.employeeId}] ✅ Conectado!`);
    } catch (error) {
      console.error(`[${this.config.employeeId}] ❌ FALHA:`, error.message);
      throw error;
    }
  }

  async listen() {
    await this.client.mailboxOpen('INBOX');
    console.log(`[${this.config.employeeId}] 📬 Monitorando...`);

    if (!this.initialCleanupDone) {
      await this.markOldAsRead();
      this.initialCleanupDone = true;
    }

    this.client.on('exists', () => this.processNew());

    // IDLE em background (não bloqueia)
    this.startIdle();
  }

  async startIdle() {
    try {
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        // IDLE com keep-alive (renova a cada 5 minutos)
        while (this.client.usable) {
          await this.client.idle();
          
          // Se chegou aqui, IDLE foi interrompido (novo e-mail ou timeout)
          // Aguardar 100ms e entrar em IDLE novamente
          await new Promise(r => setTimeout(r, 100));
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error(`[${this.config.employeeId}] ❌ IDLE erro:`, err.message);
      
      // Se erro de conexão, reconectar
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || !this.client.usable) {
        console.log(`[${this.config.employeeId}] 🔄 Reconectando...`);
        this.reconnect();
      } else {
        // Tentar IDLE novamente
        setTimeout(() => this.startIdle(), 5000);
      }
    }
  }

  async markOldAsRead() {
    try {
      console.log(`[${this.config.employeeId}] 🔒 Limpando histórico...`);
      
      const oldMessages = await this.client.search({ seen: false }, { uid: true });
      
      if (oldMessages.length > 0) {
        console.log(`[${this.config.employeeId}] 🧹 Marcando ${oldMessages.length} antigo(s)`);
        
        for (const uid of oldMessages) {
          await this.client.messageFlagsAdd(uid, ['\\Seen']);
          this.processedUIDs.set(uid, this.startTime);
        }
        
        console.log(`[${this.config.employeeId}] ✅ Histórico limpo!\n`);
      } else {
        console.log(`[${this.config.employeeId}] ✅ Sem e-mails antigos\n`);
      }
    } catch (err) {
      console.error(`[${this.config.employeeId}] ⚠️  Erro:`, err.message);
    }
  }

  async processNew() {
    try {
      const uids = await this.client.search({ seen: false }, { uid: true });
      if (!uids.length) return;

      console.log(`[${this.config.employeeId}] 📨 ${uids.length} novo(s)`);

      for (const uid of uids) {
        const lastProcessed = this.processedUIDs.get(uid);
        const now = Date.now();
        
        if (lastProcessed && (now - lastProcessed) < 30000) {
          continue;
        }

        await this.processMessage(uid);
        this.processedUIDs.set(uid, now);
      }
    } catch (err) {
      console.error(`[${this.config.employeeId}] ❌:`, err.message);
    }
  }

  async processMessage(uid) {
    try {
      const msg = await this.client.fetchOne(uid, { 
        source: true, 
        envelope: true 
      });

      let parsed;
      
      if (msg.source?.length > 0) {
        parsed = await simpleParser(msg.source);
      } else {
        parsed = {
          from: { value: [{ address: msg.envelope?.from?.[0]?.address }] },
          subject: msg.envelope?.subject || '',
          text: msg.envelope?.subject || ''
        };
      }

      let from = '';
      
      if (parsed.from?.value?.[0]?.address) {
        from = parsed.from.value[0].address;
      } else if (parsed.from?.text) {
        const match = parsed.from.text.match(/<(.+?)>/);
        from = match ? match[1] : parsed.from.text;
      } else if (msg.envelope?.from?.[0]?.address) {
        from = msg.envelope.from[0].address;
      } else if (msg.envelope?.from?.[0]) {
        const envFrom = msg.envelope.from[0];
        from = envFrom.address || `${envFrom.mailbox}@${envFrom.host}`;
      }

      from = from.toLowerCase().trim();
      
      if (!from || from.length < 3 || !from.includes('@')) {
        console.log(`[${this.config.employeeId}] ⚠️  Remetente inválido`);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        return;
      }

      const domain = from.split('@')[1] || '';

      console.log(`[${this.config.employeeId}] 📧 De: ${from}`);

      let allowed = false;

      for (const entry of ALLOWED_SENDERS) {
        const e = entry.toLowerCase().trim();
        
        if (e.includes('@')) {
          if (from === e) {
            allowed = true;
            break;
          }
        } else {
          if (domain === e) {
            allowed = true;
            break;
          }
        }
      }

      if (!allowed) {
        console.log(`[${this.config.employeeId}] ⏭️  Bloqueado`);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        return;
      }

      const subject = (parsed.subject || '').toLowerCase();
      const body = (parsed.text || '').toLowerCase();
      const fullText = `${subject} ${body}`;

      if (!fullText.includes(SECURITY_KEYWORD.toLowerCase())) {
        console.log(`[${this.config.employeeId}] 🔒 Sem palavra-chave`);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        return;
      }

      console.log(`[${this.config.employeeId}] ✅ Autorizado`);

      const codes = fullText.match(CODE_REGEX);

      if (codes?.length > 0) {
        const code = codes[0];
        console.log(`[${this.config.employeeId}] 🎯 Código: ${code}`);
        await this.save(code, from, parsed.subject || '');
      } else {
        console.log(`[${this.config.employeeId}] ℹ️  Sem código`);
      }

      await this.client.messageFlagsAdd(uid, ['\\Seen']);
    } catch (err) {
      console.error(`[${this.config.employeeId}] ❌ Erro:`, err.message);
      try {
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
      } catch (e) {
        // Ignora erro
      }
    }
  }

  async save(code, sender, subject) {
    try {
      const { data } = await supabase
        .from('verification_codes')
        .select('id')
        .eq('employee_email', this.config.user)
        .eq('code', code)
        .eq('sender', sender)
        .gte('captured_at', new Date(Date.now() - 300000).toISOString())
        .limit(1);

      if (data?.length > 0) {
        console.log(`[${this.config.employeeId}] ⏭️  Duplicata`);
        return;
      }

      await supabase.from('verification_codes').insert([{
        employee_email: this.config.user,
        employee_id: this.config.employeeId,
        code,
        sender,
        subject,
        captured_at: new Date().toISOString()
      }]);

      console.log(`[${this.config.employeeId}] ✅ Salvo!\n`);
    } catch (err) {
      console.error(`[${this.config.employeeId}] ❌ Erro:`, err.message);
    }
  }

  reconnect() {
    if (this.reconnectAttempts >= 10) {
      console.error(`[${this.config.employeeId}] ❌ Máximo`);
      return;
    }

    this.reconnectAttempts++;
    const delay = 5000 * this.reconnectAttempts;
    
    console.log(`[${this.config.employeeId}] 🔄 Em ${delay/1000}s`);
    setTimeout(() => this.start(), delay);
  }

  async stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    try {
      await this.client?.logout();
    } catch (e) {
      // Ignora
    }
  }
}

// ============================================================================
// ORQUESTRADOR
// ============================================================================
class Orchestrator {
  constructor() {
    this.monitors = [];
  }

  async start() {
    console.log('🚀 Sistema iniciado\n');
    console.log('💡 Use o dashboard para ATIVAR os monitores manualmente\n');
    console.log(`🌐 Dashboard: http://localhost:${PORT}\n`);
  }

  async addMonitor(config) {
    const monitor = new EmailMonitor(config);
    this.monitors.push(monitor);
    await monitor.start();
  }

  async stop() {
    console.log('🛑 Encerrando...');
    await Promise.all(this.monitors.map(m => m.stop()));
    process.exit(0);
  }
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
const orchestrator = new Orchestrator();

process.on('SIGINT', () => orchestrator.stop());
process.on('SIGTERM', () => orchestrator.stop());

orchestrator.start();