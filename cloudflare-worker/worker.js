const EVO_URL      = 'https://api-juliany.onrender.com';
const EVO_KEY      = 'Juliany@2024!';
const EVO_INSTANCE = 'clinica-juliany';
const CLINIC_PHONE = '5555991476251';
const REVIEW_LINK  = 'https://g.page/r/CbIF9ryRK9q-EAI/review';
const ERCLINIC_BASE = 'https://erclinic.com.br';
const PROFISSIONAL_ID = 'a8b2f274ff2e37b46aa7dcce3c3014b2';
// ERCLINIC_KEY is set via wrangler secret (env.ERCLINIC_KEY)

const AUTO_REPLY = [
  'Olá! 😊 Este número é exclusivo para envio de avaliações da Dra. Juliany.',
  '',
  'Para atendimento, entre em contato pelo WhatsApp da clínica:',
  `📞 *${CLINIC_PHONE}*`,
  '',
  'Obrigada! 🙏'
].join('\n');

const SENTIMENT_PROMPT = `Você é um classificador de sentimento. Um paciente respondeu sobre como foi sua consulta odontológica. Classifique a resposta como POSITIVO ou NEGATIVO.

Regras:
- POSITIVO: elogios, satisfação, gratidão, respostas neutras/curtas como "bom", "ok", "tudo bem", "legal", emojis positivos, ou qualquer coisa que NÃO seja uma reclamação explícita
- NEGATIVO: reclamações explícitas, insatisfação clara, críticas ao atendimento, dor, problema não resolvido

Responda APENAS com a palavra POSITIVO ou NEGATIVO, nada mais.`;

const POSITIVE_PROMPT = `Você é a assistente virtual da Dra. Juliany Carvalho, dentista. O paciente avaliou positivamente o atendimento.

Regras:
- Responda em 1-3 frases, curto e acolhedor
- Agradeça o feedback positivo
- Peça gentilmente para deixar a avaliação no Google, enfatizando a importância: ajuda outros pacientes a conhecerem o trabalho da Dra. e contribui para o crescimento da clínica
- OBRIGATÓRIO incluir o link ao final: ${REVIEW_LINK}
- Se perguntarem algo médico, redirecione para: ${CLINIC_PHONE}
- Tom: profissional, caloroso, objetivo
- Max 1 emoji por resposta
- Português brasileiro
- Sem saudação (paciente já foi saudado)
- Parecer humana e natural`;

const NEGATIVE_PROMPT = `Você é a assistente virtual da Dra. Juliany Carvalho, dentista. O paciente expressou insatisfação com o atendimento.

Regras:
- Responda em 1-3 frases, curto e empático
- Agradeça pelo feedback honesto
- Diga que a opinião é muito importante e será levada em consideração para melhorar o atendimento
- NÃO envie link de avaliação
- NÃO peça para avaliar no Google
- Se tiver uma reclamação específica, sugira entrar em contato pelo WhatsApp da clínica: ${CLINIC_PHONE}
- Tom: empático, profissional, acolhedor
- Max 1 emoji por resposta
- Português brasileiro
- Sem saudação`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function yesterdayBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000 - 86400000);
  return d.toISOString().split('T')[0];
}

function inBusinessHours() {
  const h = new Date().getUTCHours();
  return h >= 11 && h < 23;
}

function titleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ── Main export ─────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    // Ping Evolution API to keep Render alive
    try {
      await fetch(`${EVO_URL}/instance/connectionState/${EVO_INSTANCE}`, {
        headers: { apikey: EVO_KEY }
      });
    } catch {}

    if (inBusinessHours()) {
      await sendReviewQuestions(env);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname.startsWith('/check-sent/')) {
        const apptId = url.pathname.split('/check-sent/')[1];
        const sent = await env.PATIENTS_KV.get(`sent:${apptId}`);
        return new Response(sent ? 'true' : 'false', { status: 200 });
      }
      return new Response('OK', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/register-patient') {
      return handleRegister(request, env);
    }

    if (url.pathname === '/mark-sent') {
      return handleMarkSent(request, env);
    }

    return handleWebhook(request, env);
  }
};

// ── Review question sender (runs on cron) ───────────────────────────────────

async function sendReviewQuestions(env) {
  try {
    const today = todayBRT();
    const yesterday = yesterdayBRT();

    const url = new URL(`${ERCLINIC_BASE}/v2/api/publica/agenda/appointments/list`);
    url.searchParams.set('status', 'ATENDIDO');
    url.searchParams.set('date_min', yesterday);
    url.searchParams.set('date_max', today);
    url.searchParams.set('profissional_id', PROFISSIONAL_ID);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Api-Key ${env.ERCLINIC_KEY}` }
    });

    if (!res.ok) {
      console.error(`ER Clinic API ${res.status}`);
      return;
    }

    const data = await res.json();
    const appointments = data.content || [];
    console.log(`[Cron] ${appointments.length} atendimento(s) encontrado(s)`);

    for (const appt of appointments) {
      // Check KV — already sent for this appointment?
      const wasSent = await env.PATIENTS_KV.get(`sent:${appt.id}`);
      if (wasSent) continue;

      const phone = (appt.patient_cel_phone || appt.patient_phone || '').replace(/\D/g, '');
      const rawName = (appt.patient_name || 'paciente').split(' ')[0];
      const firstName = titleCase(rawName);

      if (!phone) continue;

      // Register patient BEFORE sending (prevents race condition)
      await env.PATIENTS_KV.delete(`replied:${phone}`).catch(() => {});
      await env.PATIENTS_KV.delete(`cooldown:${phone}`).catch(() => {});
      await env.PATIENTS_KV.put(`patient:${phone}`, JSON.stringify({
        name: firstName,
        registeredAt: Date.now()
      }), { expirationTtl: 172800 });

      const message = [
        `Olá, ${firstName}! 🙂`,
        '',
        `Aqui é a assistente virtual da Dra. Juliany. Espero que sua consulta tenha sido ótima!`,
        '',
        `Como você se sentiu com o atendimento hoje?`
      ].join('\n');

      await sendWhatsApp(phone, message);

      // Mark as sent in KV (7 days TTL)
      await env.PATIENTS_KV.put(`sent:${appt.id}`, '1', { expirationTtl: 604800 });

      console.log(`[Cron] Pergunta enviada para ${firstName} (${phone})`);

      // MAX 1 per cron run (anti-ban)
      return;
    }

    console.log('[Cron] Nenhum pendente');
  } catch (err) {
    console.error(`[Cron] Error: ${err.message}`);
  }
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

async function handleMarkSent(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const auth = request.headers.get('apikey') || '';
  if (auth !== EVO_KEY) return new Response('Unauthorized', { status: 401 });

  const { appointmentId } = body;
  if (!appointmentId) return new Response('Missing appointmentId', { status: 400 });

  await env.PATIENTS_KV.put(`sent:${appointmentId}`, '1', { expirationTtl: 604800 });
  return new Response('marked', { status: 200 });
}

async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const auth = request.headers.get('apikey') || '';
  if (auth !== EVO_KEY) return new Response('Unauthorized', { status: 401 });

  const { phone, name } = body;
  if (!phone || !name) return new Response('Missing phone or name', { status: 400 });

  await env.PATIENTS_KV.delete(`replied:${phone}`).catch(() => {});
  await env.PATIENTS_KV.delete(`cooldown:${phone}`).catch(() => {});

  await env.PATIENTS_KV.put(`patient:${phone}`, JSON.stringify({
    name,
    registeredAt: Date.now()
  }), { expirationTtl: 172800 });

  return new Response('registered', { status: 200 });
}

async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

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

  const alreadyReplied = await env.PATIENTS_KV.get(`replied:${phone}`);
  if (alreadyReplied) return new Response('already-replied', { status: 200 });

  const patientData = await env.PATIENTS_KV.get(`patient:${phone}`);
  if (patientData) {
    const patient = JSON.parse(patientData);
    const messageText = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || '';
    return handlePatientReply(env, phone, patient.name, messageText);
  }

  const cooldown = await env.PATIENTS_KV.get(`cooldown:${phone}`);
  if (cooldown) return new Response('cooldown', { status: 200 });

  return sendAutoReply(env, phone);
}

async function handlePatientReply(env, phone, patientName, messageText) {
  try {
    const sentimentResult = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: SENTIMENT_PROMPT },
        { role: 'user', content: `Resposta do paciente: "${messageText}"` }
      ],
      max_tokens: 10,
      temperature: 0.1
    });

    const sentiment = (sentimentResult.response || '').trim().toUpperCase();
    const isPositive = !sentiment.includes('NEGATIVO');

    console.log(`Sentiment for ${patientName}: ${sentiment} (positive=${isPositive})`);

    const responsePrompt = isPositive ? POSITIVE_PROMPT : NEGATIVE_PROMPT;
    const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: responsePrompt },
        { role: 'user', content: `O paciente ${patientName} respondeu: "${messageText}"` }
      ],
      max_tokens: 256,
      temperature: 0.7
    });

    let replyText = aiResponse.response || '';

    if (isPositive) {
      if (!replyText.includes(REVIEW_LINK)) replyText += `\n\n${REVIEW_LINK}`;
      if (!replyText.trim()) {
        replyText = `Que bom saber, ${patientName}! 😊 Sua avaliação no Google ajuda muito outros pacientes a conhecerem o trabalho da Dra. Juliany: ${REVIEW_LINK}`;
      }
    } else {
      replyText = replyText.replace(REVIEW_LINK, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!replyText) {
        replyText = `Agradecemos muito seu feedback, ${patientName}. Sua opinião é importante e vamos trabalhar para melhorar. Se precisar de algo, entre em contato: ${CLINIC_PHONE} 🙏`;
      }
    }

    await sendWhatsApp(phone, replyText);

    await env.PATIENTS_KV.put(`replied:${phone}`, '1', { expirationTtl: 86400 });
    await env.PATIENTS_KV.delete(`patient:${phone}`);

    console.log(`${isPositive ? 'Positive' : 'Negative'} reply sent to ${patientName} (${phone})`);
    return new Response(isPositive ? 'positive-reply-sent' : 'negative-reply-sent', { status: 200 });

  } catch (err) {
    console.error('AI/send error:', err.message);
    const fallback = `Que bom saber, ${patientName}! 😊 Sua avaliação no Google é muito importante e ajuda outros pacientes a conhecerem o trabalho da Dra. Juliany:\n\n${REVIEW_LINK}`;
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
