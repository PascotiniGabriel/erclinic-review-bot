const EVO_URL      = 'https://api-juliany.onrender.com';
const EVO_KEY      = 'Juliany@2024!';
const EVO_INSTANCE = 'clinica-juliany';
const CLINIC_PHONE = '5555991476251';
const REVIEW_LINK  = 'https://g.page/r/CbIF9ryRK9q-EAI/review';
const ERCLINIC_BASE = 'https://erclinic.com.br';
const PROFISSIONAL_ID = 'a8b2f274ff2e37b46aa7dcce3c3014b2';
const DRA_PHONE    = '5555996334699';

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

// Brazilian mobile numbers: WhatsApp may add/remove the 9th digit after DDD
// ER Clinic: 5555999961353 (13 digits, with 9)
// WhatsApp:  555599961353  (12 digits, without extra 9)
function phonesMatch(a, b) {
  if (a === b) return true;
  // Try removing 9th digit from the longer one (position 4 = after country+DDD)
  if (a.length === 13 && b.length === 12) {
    return a.slice(0, 4) + a.slice(5) === b;
  }
  if (b.length === 13 && a.length === 12) {
    return b.slice(0, 4) + b.slice(5) === a;
  }
  // Match last 8 digits as final fallback
  return a.length >= 8 && b.length >= 8 && a.slice(-8) === b.slice(-8);
}

// ── Main export ─────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    // Daily report at 20h BRT (23h UTC)
    if (event.cron === '0 23 * * *') {
      await sendDailyReport(env);
      return;
    }

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

    if (url.pathname === '/send-report') {
      const auth = request.headers.get('apikey') || '';
      if (auth !== EVO_KEY) return new Response('Unauthorized', { status: 401 });
      await sendDailyReport(env);
      return new Response('report-sent', { status: 200 });
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

    // PRE-REGISTER all ATENDIDO patients in KV (ensures webhook always recognizes them)
    for (const appt of appointments) {
      const phone = (appt.patient_cel_phone || appt.patient_phone || '').replace(/\D/g, '');
      if (!phone) continue;
      const rawName = (appt.patient_name || 'paciente').split(' ')[0];
      const firstName = titleCase(rawName);
      const patientJson = JSON.stringify({ name: firstName, registeredAt: Date.now() });

      // Register with BOTH phone formats (ER Clinic 13-digit and WhatsApp 12-digit)
      // WhatsApp removes 9th digit for Brazilian mobiles
      const phoneAlt = phone.length === 13 ? phone.slice(0, 4) + phone.slice(5) : phone;

      for (const p of [phone, phoneAlt]) {
        const existing = await env.PATIENTS_KV.get(`patient:${p}`);
        const alreadyReplied = await env.PATIENTS_KV.get(`replied:${p}`);
        if (!existing && !alreadyReplied) {
          await env.PATIENTS_KV.put(`patient:${p}`, patientJson, { expirationTtl: 172800 });
        }
      }
    }

    // Send initial questions (max 3 per run)
    let sentThisRun = 0;
    const MAX_PER_RUN = 3;

    for (const appt of appointments) {
      if (sentThisRun >= MAX_PER_RUN) break;

      const wasSent = await env.PATIENTS_KV.get(`sent:${appt.id}`);
      if (wasSent) continue;

      const phone = (appt.patient_cel_phone || appt.patient_phone || '').replace(/\D/g, '');
      const rawName = (appt.patient_name || 'paciente').split(' ')[0];
      const firstName = titleCase(rawName);

      if (!phone) {
        await env.PATIENTS_KV.put(`sent:${appt.id}`, 'skipped-no-phone', { expirationTtl: 604800 });
        continue;
      }

      try {
        await env.PATIENTS_KV.delete(`replied:${phone}`).catch(() => {});

        const isToday = appt.date === todayBRT();
        const quando = isToday ? 'hoje' : 'ontem';

        const message = [
          `Olá, ${firstName}! 🙂`,
          '',
          `Aqui é a assistente virtual da Dra. Juliany. Espero que sua consulta tenha sido ótima!`,
          '',
          `Como você se sentiu com o atendimento de ${quando}?`
        ].join('\n');

        await sendWhatsApp(phone, message);
        await env.PATIENTS_KV.put(`sent:${appt.id}`, '1', { expirationTtl: 604800 });
        console.log(`[Cron] Enviado para ${firstName} (${phone})`);
        sentThisRun++;
      } catch (err) {
        await env.PATIENTS_KV.put(`sent:${appt.id}`, `failed:${err.message}`, { expirationTtl: 604800 });
        console.error(`[Cron] Falha ${firstName} (${phone}): ${err.message}`);
      }
    }

    console.log(`[Cron] ${sentThisRun} enviado(s) neste ciclo`);
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

  // 1. Check KV (fast)
  let patientName = null;
  const patientData = await env.PATIENTS_KV.get(`patient:${phone}`);
  if (patientData) {
    try { patientName = JSON.parse(patientData).name; } catch {}
  }

  // 2. ER Clinic API (source of truth)
  let apiReliable = false;
  if (!patientName) {
    const result = await findPatientByPhone(phone, env);
    patientName = result.name;
    apiReliable = result.apiResponded;
  } else {
    apiReliable = true;
  }

  if (patientName) {
    // Detect audio messages
    const isAudio = !!(msg.message?.audioMessage || msg.message?.pttMessage);
    if (isAudio) {
      const audioReply = `Oi, ${patientName}! Sou a assistente virtual da Dra. Juliany e infelizmente ainda nao consigo entender audios. Poderia responder por texto? Se tiver alguma duvida, entre em contato pelo WhatsApp da clinica: ${CLINIC_PHONE}`;
      await sendWhatsApp(phone, audioReply);
      return new Response('audio-reply-sent', { status: 200 });
    }

    const messageText = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || '';
    return handlePatientReply(env, phone, patientName, messageText);
  }

  if (apiReliable) {
    // API responded, number is NOT a patient → auto-reply
    const cooldown = await env.PATIENTS_KV.get(`cooldown:${phone}`);
    if (cooldown) return new Response('cooldown', { status: 200 });
    return sendAutoReply(env, phone);
  }

  // API failed → silence (don't risk wrong message to a patient)
  console.log(`API failed for ${phone} — silent, no auto-reply`);
  return new Response('api-failed-silent', { status: 200 });
}

async function findPatientByPhone(phone, env) {
  try {
    const today = todayBRT();
    const yesterday = yesterdayBRT();
    const url = new URL(`${ERCLINIC_BASE}/v2/api/publica/agenda/appointments/list`);
    url.searchParams.set('status', 'ATENDIDO');
    url.searchParams.set('date_min', yesterday);
    url.searchParams.set('date_max', today);
    url.searchParams.set('profissional_id', PROFISSIONAL_ID);

    const apiKey = env.ERCLINIC_KEY;
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Api-Key ${apiKey}` }
    });

    if (!res.ok) {
      console.error(`ER Clinic API ${res.status}`);
      return { name: null, apiResponded: false };
    }

    const data = await res.json();
    const appointments = data.content || [];
    console.log(`ER Clinic: ${appointments.length} atendimentos, buscando ${phone}`);

    const match = appointments.find(a => {
      const p = (a.patient_cel_phone || a.patient_phone || '').replace(/\D/g, '');
      return phonesMatch(p, phone);
    });

    if (match) {
      const rawName = (match.patient_name || 'paciente').split(' ')[0];
      const name = titleCase(rawName);
      console.log(`Patient found: ${name} (${phone})`);
      return { name, apiResponded: true };
    }

    console.log(`Phone ${phone} not found in ATENDIDO list`);
    return { name: null, apiResponded: true };
  } catch (err) {
    console.error(`ER Clinic lookup error: ${err.message}`);
    return { name: null, apiResponded: false };
  }
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

    // Track daily stats for report
    await trackDailyStat(env, patientName, messageText, isPositive);

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

async function trackDailyStat(env, patientName, messageText, isPositive) {
  const date = todayBRT();
  const key = `daily_stats:${date}`;
  try {
    const raw = await env.PATIENTS_KV.get(key);
    const stats = raw ? JSON.parse(raw) : { replied: 0, positives: 0, negatives: [] };
    stats.replied = (stats.replied || 0) + 1;
    if (isPositive) {
      stats.positives = (stats.positives || 0) + 1;
    } else {
      stats.negatives = stats.negatives || [];
      stats.negatives.push({ name: patientName, text: messageText });
    }
    await env.PATIENTS_KV.put(key, JSON.stringify(stats), { expirationTtl: 172800 });
  } catch (err) {
    console.error('trackDailyStat error:', err.message);
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

async function sendDailyReport(env) {
  try {
    const date = todayBRT();

    // Count sent today via ER Clinic
    const url = new URL(`${ERCLINIC_BASE}/v2/api/publica/agenda/appointments/list`);
    url.searchParams.set('status', 'ATENDIDO');
    url.searchParams.set('date_min', date);
    url.searchParams.set('date_max', date);
    url.searchParams.set('profissional_id', PROFISSIONAL_ID);

    let sentCount = 0;
    let duplicatePhones = 0;
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Api-Key ${env.ERCLINIC_KEY}` }
      });
      if (res.ok) {
        const data = await res.json();
        const appointments = data.content || [];
        const sentPhones = new Set();
        for (const appt of appointments) {
          const wasSent = await env.PATIENTS_KV.get(`sent:${appt.id}`);
          if (wasSent === '1') {
            const rawPhone = (appt.patient_cel_phone || appt.patient_phone || '').replace(/\D/g, '');
            // Normalize to 12-digit for dedup (remove 9th digit if 13-digit)
            const normPhone = rawPhone.length === 13 ? rawPhone.slice(0, 4) + rawPhone.slice(5) : rawPhone;
            if (sentPhones.has(normPhone)) {
              duplicatePhones++;
            } else {
              sentPhones.add(normPhone);
              sentCount++;
            }
          }
        }
      }
    } catch {}

    // Load daily stats
    const raw = await env.PATIENTS_KV.get(`daily_stats:${date}`);
    const stats = raw ? JSON.parse(raw) : { replied: 0, positives: 0, negatives: [] };
    const replied = stats.replied || 0;
    const positives = stats.positives || 0;
    const negatives = stats.negatives || [];

    // Format date BR
    const [y, m, d] = date.split('-');
    const dateBR = `${d}/${m}/${y}`;

    const lines = [
      `📊 *Relatório do dia ${dateBR}*`,
      '',
      `✅ Mensagens enviadas: *${sentCount}*`,
    ];

    if (duplicatePhones > 0) {
      lines.push(`_⚠️ ${duplicatePhones} agendamento(s) com número duplicado (mesmo paciente/familiar) — não contabilizado(s) acima._`);
    }

    lines.push(`💬 Responderam: *${replied}*`);
    lines.push(`⭐ Receberam link de avaliação: *${positives}*`);

    if (negatives.length > 0) {
      lines.push('');
      lines.push(`❌ *Feedbacks negativos (${negatives.length}):*`);
      for (const n of negatives) {
        lines.push(`• *${n.name}:* "${n.text}"`);
      }
    }

    if (replied === 0 && !raw) {
      lines.push('');
      lines.push('_Nenhuma resposta registrada hoje. Se pacientes responderam antes das 21h de hoje, os dados não foram capturados (sistema de tracking ativado hoje)._');
    } else if (replied === 0) {
      lines.push('');
      lines.push('_Nenhuma resposta dos pacientes hoje._');
    }

    const message = lines.join('\n');
    await sendWhatsApp(DRA_PHONE, message);
    console.log(`[Report] Sent daily report to Dra. (${date}): ${sentCount} sent, ${replied} replied, ${positives} positive, ${negatives.length} negative`);
  } catch (err) {
    console.error('[Report] Error:', err.message);
  }
}
