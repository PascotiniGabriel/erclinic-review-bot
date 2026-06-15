// Cloudflare Worker — auto-resposta WhatsApp Dra. Juliany
// Deploy: https://workers.cloudflare.com (free, 100k req/dia)

const EVO_URL      = 'https://api-juliany.onrender.com';
const EVO_KEY      = 'Juliany@2024!';
const EVO_INSTANCE = 'clinica-juliany';
const CLINIC_PHONE = '5555991476251'; // número de atendimento
const AUTO_REPLY   = `Olá! 😊 Este número é exclusivo para envio de avaliações da Dra. Juliany.\n\nPara atendimento, entre em contato pelo número de WhatsApp da clínica:\n📞 *${CLINIC_PHONE}*\n\nObrigada! 🙏`;

// Números que já respondemos nesta instância do Worker (memória volátil, OK pra rate-limit simples)
const recentlySent = new Map();
const COOLDOWN_MS  = 60 * 60 * 1000; // 1h — não responde mesmo número mais de 1x/hora

export default {
  async fetch(request) {
    // Cloudflare faz GET pra verificar webhook — responder 200
    if (request.method === 'GET') {
      return new Response('OK', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    console.log('Webhook received:', JSON.stringify(body));

    // Evolution API v2 envia evento de mensagem recebida
    const event = body.event || body.type;
    if (!['messages.upsert', 'message'].includes(event)) {
      return new Response('ignored', { status: 200 });
    }

    const msg = body.data?.message || body.data;
    if (!msg) return new Response('no message', { status: 200 });

    // Ignorar mensagens enviadas por nós mesmos
    if (msg.key?.fromMe) return new Response('fromMe', { status: 200 });

    // Número do remetente
    const remoteJid = msg.key?.remoteJid || '';
    if (!remoteJid || remoteJid.includes('@g.us')) {
      // Ignorar grupos
      return new Response('group or empty', { status: 200 });
    }

    const phone = remoteJid.replace('@s.whatsapp.net', '');

    // Rate-limit: não responder mesmo número por 1h
    const lastSent = recentlySent.get(phone);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
      console.log(`Rate-limited: ${phone}`);
      return new Response('rate-limited', { status: 200 });
    }

    // Enviar auto-resposta
    try {
      const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
        method: 'POST',
        headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: phone, text: AUTO_REPLY })
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error(`Evolution error ${res.status}: ${txt}`);
        return new Response('evo error', { status: 500 });
      }

      recentlySent.set(phone, Date.now());
      console.log(`Auto-reply sent to ${phone}`);
      return new Response('sent', { status: 200 });

    } catch (err) {
      console.error('Fetch error:', err.message);
      return new Response('error', { status: 500 });
    }
  }
};
