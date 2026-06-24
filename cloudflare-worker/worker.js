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
    // Step 1: Classify sentiment
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

    // Step 2: Generate response based on sentiment
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

    // Fallbacks
    if (isPositive) {
      if (!replyText.includes(REVIEW_LINK)) {
        replyText += `\n\n${REVIEW_LINK}`;
      }
      if (!replyText.trim()) {
        replyText = `Que bom saber, ${patientName}! 😊 Sua avaliação no Google ajuda muito outros pacientes a conhecerem o trabalho da Dra. Juliany: ${REVIEW_LINK}`;
      }
    } else {
      // Remove review link if AI accidentally included it
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
    console.error('AI/send error:', err.message, err.stack);
    // Fallback: send generic positive response with link
    const fallback = `Que bom saber, ${patientName}! 😊 Sua avaliação no Google é muito importante e ajuda outros pacientes a conhecerem o trabalho da Dra. Juliany:\n\n${REVIEW_LINK}`;
    try { await sendWhatsApp(phone, fallback); } catch {}
    await env.PATIENTS_KV.put(`replied:${phone}`, '1', { expirationTtl: 86400 }).catch(() => {});
    await env.PATIENTS_KV.delete(`patient:${phone}`).catch(() => {});
    return new Response(JSON.stringify({ status: 'fallback-sent', error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
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
