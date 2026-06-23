const EVO_URL      = 'https://api-juliany.onrender.com';
const EVO_KEY      = 'Juliany@2024!';
const EVO_INSTANCE = 'clinica-juliany';
const CLINIC_PHONE = '5555991476251';
const REVIEW_LINK  = 'https://g.page/r/CbIF9ryRK9q-EAI/review';

const AUTO_REPLY = [
  'Olá! 😊 Este número é exclusivo para envio de avaliações da Dra. Juliany.',
  '',
  'Para atendimento, entre em contato pelo WhatsApp da clínica:',
  `📞 *${CLINIC_PHONE}*`,
  '',
  'Obrigada! 🙏'
].join('\n');

const SYSTEM_PROMPT = `Você é a assistente virtual da Dra. Juliany Carvalho, dentista. Um paciente acabou de ser atendido e recebeu uma pergunta sobre como foi a consulta. Agora ele respondeu.

Regras obrigatórias:
- Responda em 1-3 frases, curto e acolhedor
- SEMPRE inclua o link de avaliação no Google ao final: ${REVIEW_LINK}
- Se perguntarem algo sobre consulta, agendamento ou dúvida médica, redirecione para o WhatsApp da clínica: ${CLINIC_PHONE}
- Nunca dê conselhos ou informações médicas/odontológicas
- Tom: profissional, caloroso, objetivo
- Use no máximo 1 emoji por resposta
- Responda em português brasileiro
- Não use saudação (o paciente já foi saudado antes)
- A resposta deve parecer humana e natural, não robótica`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      return new Response('OK', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/register-patient') {
      return handleRegister(request, env);
    }

    return handleWebhook(request, env);
  }
};

async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const auth = request.headers.get('apikey') || '';
  if (auth !== EVO_KEY) return new Response('Unauthorized', { status: 401 });

  const { phone, name } = body;
  if (!phone || !name) return new Response('Missing phone or name', { status: 400 });

  await env.PATIENTS_KV.put(`patient:${phone}`, JSON.stringify({
    name,
    registeredAt: Date.now()
  }), { expirationTtl: 172800 }); // 48h

  console.log(`Patient registered: ${name} (${phone})`);
  return new Response('registered', { status: 200 });
}

async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  console.log('Webhook received:', JSON.stringify(body));

  const event = body.event || body.type;
  if (!['messages.upsert', 'message'].includes(event)) {
    return new Response('ignored', { status: 200 });
  }

  const dataRaw = body.data;
  const msg = Array.isArray(dataRaw) ? dataRaw[0] : dataRaw;
  if (!msg?.key) return new Response('no message', { status: 200 });
  if (msg.key?.fromMe) return new Response('fromMe', { status: 200 });

  const remoteJid = msg.key?.remoteJid || '';
  if (!remoteJid || remoteJid.includes('@g.us')) {
    return new Response('group or empty', { status: 200 });
  }

  const phone = remoteJid.replace('@s.whatsapp.net', '');

  // Already sent review link? 24h cooldown
  const alreadyReplied = await env.PATIENTS_KV.get(`replied:${phone}`);
  if (alreadyReplied) {
    console.log(`Already sent review link to ${phone}`);
    return new Response('already-replied', { status: 200 });
  }

  // Check if registered patient (review bot sent initial question)
  const patientData = await env.PATIENTS_KV.get(`patient:${phone}`);

  if (patientData) {
    const patient = JSON.parse(patientData);
    const messageText = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || '';
    return handlePatientReply(env, phone, patient.name, messageText);
  }

  // Not a patient — standard auto-reply with 1h cooldown
  const cooldown = await env.PATIENTS_KV.get(`cooldown:${phone}`);
  if (cooldown) {
    console.log(`Cooldown active for ${phone}`);
    return new Response('cooldown', { status: 200 });
  }

  return sendAutoReply(env, phone);
}

async function handlePatientReply(env, phone, patientName, messageText) {
  try {
    const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `O paciente ${patientName} respondeu: "${messageText}"` }
      ],
      max_tokens: 256,
      temperature: 0.7
    });

    let replyText = aiResponse.response || '';

    // Fallback if AI didn't include review link
    if (!replyText.includes(REVIEW_LINK)) {
      replyText += `\n\n${REVIEW_LINK}`;
    }

    // Fallback if AI returned empty
    if (!replyText.trim()) {
      replyText = `Obrigada pelo retorno, ${patientName}! 😊 Se puder, avalie sua consulta aqui: ${REVIEW_LINK}`;
    }

    await sendWhatsApp(phone, replyText);

    // Mark as replied (24h cooldown) + remove from pending
    await env.PATIENTS_KV.put(`replied:${phone}`, '1', { expirationTtl: 86400 });
    await env.PATIENTS_KV.delete(`patient:${phone}`);

    console.log(`AI reply sent to patient ${patientName} (${phone})`);
    return new Response('ai-reply-sent', { status: 200 });

  } catch (err) {
    console.error('AI/send error:', err.message);
    const fallback = `Obrigada pelo retorno! 😊 Se puder, avalie sua consulta aqui: ${REVIEW_LINK}`;
    try { await sendWhatsApp(phone, fallback); } catch {}
    await env.PATIENTS_KV.put(`replied:${phone}`, '1', { expirationTtl: 86400 }).catch(() => {});
    await env.PATIENTS_KV.delete(`patient:${phone}`).catch(() => {});
    return new Response('fallback-sent', { status: 200 });
  }
}

async function sendAutoReply(env, phone) {
  try {
    await sendWhatsApp(phone, AUTO_REPLY);
    await env.PATIENTS_KV.put(`cooldown:${phone}`, '1', { expirationTtl: 3600 });
    console.log(`Auto-reply sent to ${phone}`);
    return new Response('auto-reply-sent', { status: 200 });
  } catch (err) {
    console.error('Send error:', err.message);
    return new Response('error', { status: 500 });
  }
}

async function sendWhatsApp(phone, text) {
  const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: phone, text })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Evolution API ${res.status}: ${txt}`);
  }
}
