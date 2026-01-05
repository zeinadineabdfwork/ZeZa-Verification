// worker.js - Sistema de Monitoramento de E-mails Multi-Conta
// Autor: Sistema de Verificação de Códigos
// Versão: 1.0.0

// Carregar variáveis de ambiente
require('dotenv').config();

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE
// ============================================================================
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ ERRO: Variáveis de ambiente obrigatórias não encontradas:');
  missingEnvVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('\n💡 Crie um arquivo .env baseado no .env.example');
  process.exit(1);
}

// ============================================================================
// CONFIGURAÇÃO DO SUPABASE
// ============================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============================================================================
// CONFIGURAÇÃO DAS CONTAS DE E-MAIL
// ============================================================================
const EMAIL_ACCOUNTS = [
  {
    user: 'saifafaruk40@gmail.com',
    pass: 'icin aeex aher dohg', // Senha de App do Google
    employeeId: 'EMP001'
  }
  // ... adicione até 20 contas aqui
];

// ============================================================================
// REMETENTES PERMITIDOS (whitelist de domínios)
// ============================================================================
const ALLOWED_SENDERS = [
  'facebook.com',
  'facebookmail.com',
  'google.com',
  'instagram.com',
  'tiktok.com',
  'accounts.google.com',
  'security-noreply@google.com',
  'zeinadine.abd@gmail.com'
];

// ============================================================================
// REGEX PARA EXTRAÇÃO DE CÓDIGOS
// ============================================================================
// Padrão: 4 a 8 dígitos consecutivos (ex: 123456, 12345678)
const CODE_REGEX = /\b(\d{4,8})\b/g;

// ============================================================================
// CLASSE DE MONITORAMENTO POR CONTA
// ============================================================================
class EmailMonitor {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 segundos
  }

  // --------------------------------------------------------------------------
  // Método Principal: Iniciar Monitoramento
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Conectar ao servidor IMAP do Gmail
  // --------------------------------------------------------------------------
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
        logger: false, // Desabilita logs verbosos
        // Configurações de timeout para evitar desconexões
        socketTimeout: 60000,
        greetingTimeout: 30000
      });

      // Event handlers para gerenciar a conexão
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

  // --------------------------------------------------------------------------
  // Configurar listener IDLE para monitoramento em tempo real
  // --------------------------------------------------------------------------
  async setupIdleListener() {
    try {
      // Selecionar a caixa de entrada
      await this.client.mailboxOpen('INBOX');
      console.log(`[${this.config.employeeId}] 📬 INBOX aberta, aguardando novos e-mails...`);

      // CRÍTICO: Usar evento 'exists' para captura instantânea
      this.client.on('exists', async (data) => {
        console.log(`[${this.config.employeeId}] 🔔 Novo e-mail detectado! Count: ${data.count}`);
        await this.processNewEmails();
      });

      // Manter a conexão ativa com IDLE
      let lock = await this.client.getMailboxLock('INBOX');
      try {
        // IDLE aguarda novos e-mails indefinidamente
        await this.client.idle();
      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(`[${this.config.employeeId}] Erro no IDLE:`, error.message);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Processar novos e-mails recebidos
  // --------------------------------------------------------------------------
  async processNewEmails() {
    try {
      // Buscar os últimos 5 e-mails não lidos
      const messages = await this.client.search({
        seen: false
      }, {
        uid: true
      });

      if (messages.length === 0) {
        console.log(`[${this.config.employeeId}] Nenhum e-mail novo não lido`);
        return;
      }

      console.log(`[${this.config.employeeId}] Processando ${messages.length} e-mail(s) novo(s)`);

      // Processar cada mensagem
      for (const uid of messages.slice(-5)) { // Últimos 5 para evitar sobrecarga
        await this.processMessage(uid);
      }

    } catch (error) {
      console.error(`[${this.config.employeeId}] Erro ao processar e-mails:`, error.message);
    }
  }

  // --------------------------------------------------------------------------
  // Processar mensagem individual
  // --------------------------------------------------------------------------
  async processMessage(uid) {
    try {
      // Fazer download da mensagem
      const message = await this.client.fetchOne(uid, {
        source: true,
        flags: true
      });

      // Parse do e-mail
      const parsed = await simpleParser(message.source);
      
      // Extrair remetente
      const fromAddress = parsed.from?.value[0]?.address || '';
      const fromDomain = fromAddress.split('@')[1]?.toLowerCase() || '';

      // FILTRO DE SEGURANÇA: Verificar se é de remetente permitido
      const isAllowed = ALLOWED_SENDERS.some(domain => 
        fromDomain.includes(domain.toLowerCase())
      );

      if (!isAllowed) {
        console.log(`[${this.config.employeeId}] ⏭️  E-mail de ${fromAddress} ignorado (não está na whitelist)`);
        // Marcar como lido para não processar novamente
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
        return;
      }

      console.log(`[${this.config.employeeId}] 🔍 Processando e-mail de ${fromAddress}`);

      // Extrair texto do e-mail (subject + body)
      const emailText = `${parsed.subject || ''} ${parsed.text || ''}`;

      // EXTRAÇÃO DE CÓDIGOS usando Regex
      const codes = this.extractCodes(emailText);

      if (codes.length > 0) {
        console.log(`[${this.config.employeeId}] 🎯 Códigos encontrados:`, codes);
        
        // Salvar no banco de dados
        for (const code of codes) {
          await this.saveToDatabase(code, fromAddress, parsed.subject);
        }

        // Marcar como lido após processamento bem-sucedido
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
      } else {
        console.log(`[${this.config.employeeId}] ℹ️  Nenhum código encontrado no e-mail`);
        await this.client.messageFlagsAdd(uid, ['\\Seen']);
      }

    } catch (error) {
      console.error(`[${this.config.employeeId}] Erro ao processar mensagem ${uid}:`, error.message);
    }
  }

  // --------------------------------------------------------------------------
  // Extrair códigos numéricos do texto
  // --------------------------------------------------------------------------
  extractCodes(text) {
    if (!text) return [];
    
    const matches = text.match(CODE_REGEX);
    if (!matches) return [];

    // Remover duplicatas e retornar
    return [...new Set(matches)];
  }

  // --------------------------------------------------------------------------
  // Salvar código no Supabase
  // --------------------------------------------------------------------------
  async saveToDatabase(code, sender, subject) {
    try {
      const { data, error } = await supabase
        .from('verification_codes')
        .insert([
          {
            employee_email: this.config.user,
            employee_id: this.config.employeeId,
            code: code,
            sender: sender,
            subject: subject,
            captured_at: new Date().toISOString()
          }
        ]);

      if (error) throw error;

      console.log(`[${this.config.employeeId}] ✅ Código ${code} salvo no banco de dados`);
      
    } catch (error) {
      console.error(`[${this.config.employeeId}] ❌ Erro ao salvar no banco:`, error.message);
    }
  }

  // --------------------------------------------------------------------------
  // Agendar reconexão automática
  // --------------------------------------------------------------------------
  async scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[${this.config.employeeId}] ❌ Máximo de tentativas de reconexão atingido. Abortando.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts; // Backoff exponencial

    console.log(`[${this.config.employeeId}] 🔄 Tentativa de reconexão ${this.reconnectAttempts}/${this.maxReconnectAttempts} em ${delay/1000}s...`);

    setTimeout(async () => {
      try {
        await this.start();
      } catch (error) {
        console.error(`[${this.config.employeeId}] Falha na reconexão:`, error.message);
      }
    }, delay);
  }

  // --------------------------------------------------------------------------
  // Desconectar gracefully
  // --------------------------------------------------------------------------
  async disconnect() {
    if (this.client) {
      try {
        await this.client.logout();
        console.log(`[${this.config.employeeId}] Desconectado`);
      } catch (error) {
        console.error(`[${this.config.employeeId}] Erro ao desconectar:`, error.message);
      }
    }
  }
}

// ============================================================================
// ORQUESTRADOR PRINCIPAL
// ============================================================================
class EmailMonitorOrchestrator {
  constructor() {
    this.monitors = [];
  }

  // Iniciar monitoramento de todas as contas
  async startAll() {
    console.log('🚀 Iniciando sistema de monitoramento de e-mails...');
    console.log(`📊 Total de contas configuradas: ${EMAIL_ACCOUNTS.length}`);

    for (const account of EMAIL_ACCOUNTS) {
      const monitor = new EmailMonitor(account);
      this.monitors.push(monitor);
      
      // Iniciar com pequeno delay entre contas para evitar rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
      monitor.start().catch(err => {
        console.error(`Erro ao iniciar monitor para ${account.user}:`, err.message);
      });
    }

    console.log('✅ Todos os monitores iniciados!');
  }

  // Desligar todos os monitores
  async stopAll() {
    console.log('🛑 Desligando sistema...');
    
    for (const monitor of this.monitors) {
      await monitor.disconnect();
    }

    console.log('✅ Sistema desligado');
    process.exit(0);
  }
}

// ============================================================================
// INICIALIZAÇÃO DO SISTEMA
// ============================================================================
const orchestrator = new EmailMonitorOrchestrator();

// Handlers para encerramento graceful
process.on('SIGINT', async () => {
  console.log('\n📛 SIGINT recebido');
  await orchestrator.stopAll();
});

process.on('SIGTERM', async () => {
  console.log('\n📛 SIGTERM recebido');
  await orchestrator.stopAll();
});

// Iniciar o sistema
orchestrator.startAll().catch(err => {
  console.error('❌ Erro fatal ao iniciar sistema:', err);
  process.exit(1);
});

console.log('💡 Sistema rodando. Pressione Ctrl+C para encerrar.');