 require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const path = require('path');

// --- INICIALIZAÇÃO DO SERVIDOR WEB ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`\n🌐 INTERFACE WEB ATIVA: http://localhost:${port}`);
  console.log(`💡 Acesse no navegador para ver o dashboard em tempo real.\n`);
});

// --- VALIDAÇÃO DE AMBIENTE ---
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ ERRO: Variáveis de ambiente obrigatórias não encontradas:');
  missingEnvVars.forEach(varName => console.error(`   - ${varName}`));
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÃO DE CONTAS
const EMAIL_ACCOUNTS = [
  {
    user: 'saifafaruk40@gmail.com',
    pass: 'icin aeex aher dohg',
    employeeId: 'EMP001'
  }

];

const ALLOWED_SENDERS = [
  'facebookmail.com', 
  'google.com',
  'instagram.com',
  'tiktok.com',
  'gmail.com',
  'simo.co.mz' 
];

const CODE_REGEX = /\b(\d{6,8})\b/g;

class EmailMonitor {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.processedMessages = new Set(); // Cache de mensagens já processadas
  }

  async start() {
    console.log(`[${this.config.employeeId}] Iniciando monitoramento para ${this.config.user}`);
    try {
      await this.connect();
      await this.setupIdleListener();
    } catch (error) {
      console.error(`[${this.config.employeeId}] Erro ao iniciar:`, error.message);
      await this.scheduleReconnect();
    }
  }

  async connect() {
    try {
      this.client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
          user: this.config.user,
          pass: this.config.pass
        },
        logger: false,
        socketTimeout: 60000,
        greetingTimeout: 30000
      });

      this.client.on('error', (err) => {
        console.error(`[${this.config.employeeId}] Erro de conexão:`, err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        console.log(`[${this.config.employeeId}] Conexão fechada`);
        this.isConnected = false;
        this.scheduleReconnect();
      });

      await this.client.connect();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log(`[${this.config.employeeId}] ✅ Conectado com sucesso`);
    } catch (error) {
      throw new Error(`Falha na conexão: ${error.message}`);
    }
  }

  async setupIdleListener() {
    try {
      await this.client.mailboxOpen('INBOX');
      console.log(`[${this.config.employeeId}] 📬 INBOX aberta, aguardando novos e-mails...`);

      this.client.on('exists', async (data) => {
        console.log(`[${this.config.employeeId}] 🔔 Novo e-mail detectado! Count: ${data.count}`);
        await this.processNewEmails();
      });

      let lock = await this.client.getMailboxLock('INBOX');
      try {
        await this.client.idle();
      } finally {
        lock.release();
      }
    } catch (error) {
      console.error(`[${this.config.employeeId}] Erro no IDLE:`, error.message);
      throw error;
    }
  }

  async processNewEmails() {
    try {
      const messages = await this.client.search({ seen: false }, { uid: true });
      if (messages.length === 0) return;

      console.log(`[${this.config.employeeId}] Processando ${messages.length} e-mail(s) novo(s)`);

      for (const uid of messages.slice(-5)) {
        // Verificar se já processou esta mensagem (evita duplicatas na mesma sessão)
        if (this.processedMessages.has(uid)) {
          console.log(`[${this.config.employeeId}] ⏭️  UID ${uid} já processado nesta sessão`);
          continue;
        }

        await this.processMessage(uid);
        this.processedMessages.add(uid);
      }
    } catch (error) {
      console.error(`[${this.config.employeeId}] Erro ao processar e-mails:`, error.message);
    }
  }

  async processMessage(uid) {
    try {
      console.log(`[${this.config.employeeId}] 📥 Buscando mensagem UID ${uid}...`);

      let message = await this.client.fetchOne(uid, { 
        source: true, 
        envelope: true,
        bodyStructure: true,
        flags: true
      });

      let parsed = null;

      if (!message.source || message.source.length === 0) {
        try {
          const parts = [];
          if (message.bodyStructure && message.bodyStructure.childNodes) {
            for (let i = 0; i < message.bodyStructure.childNodes.length; i++) {
              try {
                const part = await this.client.download(uid, `${i + 1}`, { uid: true });
                if (part && part.content) parts.push(part.content);
              } catch (e) {}
            }
          }
          if (parts.length > 0) {
            parsed = await simpleParser(Buffer.concat(parts));
          } else {
            const download = await this.client.download(uid, '1', { uid: true });
            parsed = await simpleParser(download.content);
          }
        } catch (altError) {
          if (message.envelope) {
            parsed = {
              from: { value: [{ address: message.envelope.from?.[0]?.address }] },
              subject: message.envelope.subject,
              text: message.envelope.subject || ''
            };
          }
        }
      } else {
        parsed = await simpleParser(message.source);
      }

      if (!parsed) {
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        return;
      }

      const fromAddress = parsed.from?.value?.[0]?.address || 
                         message.envelope?.from?.[0]?.address || 
                         'desconhecido';
      const fromDomain = fromAddress.includes('@') 
        ? fromAddress.split('@')[1]?.toLowerCase() || '' 
        : '';

      // Verificar whitelist
      const isAllowed = ALLOWED_SENDERS.some(domain => 
        fromDomain.includes(domain.toLowerCase())
      );

      if (!isAllowed) {
        console.log(`[${this.config.employeeId}] ⏭️  E-mail de ${fromAddress} ignorado`);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        return;
      }

      console.log(`[${this.config.employeeId}] 🔍 Processando e-mail de ${fromAddress}`);

      const subject = parsed.subject || '';
      const textBody = parsed.text || '';
      const htmlBody = parsed.html ? parsed.html.replace(/<[^>]*>/g, ' ') : '';
      const emailText = `${subject} ${textBody} ${htmlBody}`;

      console.log(`[${this.config.employeeId}] 📝 Assunto: ${subject}`);

      // Extrair códigos
      const codes = this.extractCodes(emailText);

      if (codes.length > 0) {
        // PEGAR APENAS O PRIMEIRO CÓDIGO
        const firstCode = codes[0]; 
        console.log(`[${this.config.employeeId}] 🎯 Primeiro código: ${firstCode} (outros ignorados: ${codes.slice(1).join(', ') || 'nenhum'})`);
        
        await this.saveToDatabase(firstCode, fromAddress, subject);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        console.log(`[${this.config.employeeId}] ✅ Processado com sucesso!`);
      } else {
        console.log(`[${this.config.employeeId}] ℹ️  Nenhum código encontrado`);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
      }

    } catch (error) {
      console.error(`[${this.config.employeeId}] ❌ Erro:`, error.message);
      try {
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
      } catch (e) {}
    }
  }

  extractCodes(text) {
    if (!text) return [];
    const matches = text.match(CODE_REGEX);
    return matches ? [...new Set(matches)] : [];
  }

  async saveToDatabase(code, sender, subject) {
    try {
      // VERIFICAR SE JÁ EXISTE (últimos 5 minutos)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      
      const { data: existing, error: checkError } = await supabase
        .from('verification_codes')
        .select('id')
        .eq('employee_email', this.config.user)
        .eq('code', code)
        .eq('sender', sender)
        .gte('captured_at', fiveMinutesAgo)
        .limit(1);

      if (checkError) {
        console.error(`[${this.config.employeeId}] Erro ao verificar duplicata:`, checkError.message);
        return;
      }

      if (existing && existing.length > 0) {
        console.log(`[${this.config.employeeId}] ⏭️  Código ${code} já existe no banco (duplicata ignorada)`);
        return;
      }

      // Inserir no banco
      const { error } = await supabase
        .from('verification_codes')
        .insert([{
          employee_email: this.config.user,
          employee_id: this.config.employeeId,
          code: code,
          sender: sender,
          subject: subject,
          captured_at: new Date().toISOString()
        }]);

      if (error) throw error;
      console.log(`[${this.config.employeeId}] ✅ Código ${code} salvo no banco`);
    } catch (error) {
      console.error(`[${this.config.employeeId}] ❌ Erro ao salvar:`, error.message);
    }
  }

  async scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    console.log(`[${this.config.employeeId}] 🔄 Reconectando em ${delay/1000}s...`);
    setTimeout(async () => { await this.start(); }, delay);
  }

  async disconnect() {
    if (this.client) { 
      try { 
        await this.client.logout(); 
        console.log(`[${this.config.employeeId}] Desconectado`);
      } catch (e) {} 
    }
  }
}

class EmailMonitorOrchestrator {
  constructor() { this.monitors = []; }
  
  async startAll() {
    console.log('🚀 Iniciando sistema de monitoramento...');
    console.log(`📊 Total de contas: ${EMAIL_ACCOUNTS.length}`);
    
    for (const account of EMAIL_ACCOUNTS) {
      const monitor = new EmailMonitor(account);
      this.monitors.push(monitor);
      await new Promise(r => setTimeout(r, 1000));
      monitor.start().catch(err => console.error("Erro no monitor:", err));
    }
    
    console.log('✅ Todos os monitores iniciados!');
  }
  
  async stopAll() {
    console.log('🛑 Desligando sistema...');
    for (const monitor of this.monitors) { 
      await monitor.disconnect(); 
    }
    console.log('✅ Sistema desligado');
    process.exit(0);
  }
}

const orchestrator = new EmailMonitorOrchestrator();
process.on('SIGINT', async () => { 
  console.log('\n📛 SIGINT recebido');
  await orchestrator.stopAll(); 
});
process.on('SIGTERM', async () => { 
  console.log('\n📛 SIGTERM recebido');
  await orchestrator.stopAll(); 
});

orchestrator.startAll().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});

console.log('💡 Sistema rodando. Pressione Ctrl+C para encerrar.');