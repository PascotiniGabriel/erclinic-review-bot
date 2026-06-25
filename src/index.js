'use strict';

const ERCLINIC_KEY      = process.env.ERCLINIC_API_KEY;
const ERCLINIC_BASE     = 'https://erclinic.com.br';
const PROFISSIONAL_ID   = process.env.ERCLINIC_PROFISSIONAL_ID || 'a8b2f274ff2e37b46aa7dcce3c3014b2';
const EVO_URL           = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const EVO_KEY           = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCE      = process.env.EVOLUTION_INSTANCE;
const WORKER_URL        = 'https://autoreply-juliany.gabriel-pascotini.workers.dev';

const MAX_PER_RUN = 3;

function todayBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function nowBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function inBusinessHours() {
  const h = new Date().getUTCHours();
  return h >= 11 && h < 23;
}

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

// ── ER Clinic API ────────────────────────────────────────────────────────────

async function erclinicGet(path, params = {}) {
  const url = new URL(ERCLINIC_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Api-Key ${ERCLINIC_KEY}` }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ER Clinic GET ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

async function markSent(id) {
  const url = `${ERCLINIC_BASE}/v2/api/publica/agenda/appointments/${id}?agenda_id=${id}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Api-Key ${ERCLINIC_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      reminder_sent_date: nowBRT(),
      observation: 'Pergunta de avaliação enviada via automação.'
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`markSent ${id.slice(0, 8)}… → ${res.status}: ${txt}`);
  }
}

// ── WhatsApp + Worker ────────────────────────────────────────────────────────

async function sendInitialQuestion(rawPhone, firstName) {
  const phone = rawPhone.replace(/\D/g, '');

  // PRIMEIRO: registrar paciente no Worker ANTES de enviar mensagem
  // (evita race condition se paciente responder instantaneamente)
  await fetch(`${WORKER_URL}/register-patient`, {
    method: 'POST',
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name: firstName })
  }).catch(err => {
    console.error(`  ⚠ Falha ao registrar paciente no Worker: ${err.message}`);
  });

  const message = [
    `Olá, ${firstName}! 🙂`,
    '',
    `Aqui é a assistente virtual da Dra. Juliany. Espero que sua consulta tenha sido ótima!`,
    '',
    `Como você se sentiu com o atendimento hoje?`
  ].join('\n');

  // Typing indicator
  await fetch(`${EVO_URL}/chat/sendPresence/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: phone, options: { presence: 'composing', delay: 3000 } })
  }).catch(() => {});

  await randomDelay(3000, 6000);

  const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: phone, text: message })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Evolution API → ${res.status}: ${txt}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.TEST_PHONE) {
    const phone = process.env.TEST_PHONE.replace(/\D/g, '');
    console.log(`[TESTE] Enviando pergunta de teste para ${phone}…`);
    await sendInitialQuestion(phone, 'Teste');
    console.log(`[TESTE] Mensagem enviada e paciente registrado!`);
    return;
  }

  if (!inBusinessHours()) {
    console.log('Fora do horário comercial (8h–20h BRT). Nada a fazer.');
    return;
  }

  const today = todayBRT();
  // Look back 1 day to catch patients missed yesterday
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000 - 86400000);
  const yesterday = d.toISOString().split('T')[0];
  console.log(`[${new Date().toISOString()}] Verificando atendimentos de ${yesterday} a ${today}…`);

  const data = await erclinicGet('/v2/api/publica/agenda/appointments/list', {
    status: 'ATENDIDO',
    date_min: yesterday,
    date_max: today,
    profissional_id: PROFISSIONAL_ID
  });

  const appointments = data.content || [];
  console.log(`${appointments.length} atendimento(s) encontrado(s).`);

  let sent = 0;

  for (const appt of appointments) {
    if (sent >= MAX_PER_RUN) {
      console.log(`  ⚠ Limite de ${MAX_PER_RUN} msgs/execução. Restantes na próxima rodada.`);
      break;
    }

    // Check Worker KV for sent status (by appointment ID — each consulta é única)
    try {
      const checkRes = await fetch(`${WORKER_URL}/check-sent/${appt.id}`);
      const wasSent = await checkRes.text();
      if (wasSent === 'true') {
        console.log(`  ↷ ${appt.id.slice(0, 10)}… — já enviada (KV)`);
        continue;
      }
    } catch {}

    const phone = appt.patient_cel_phone || appt.patient_phone;
    const rawName = (appt.patient_name || 'paciente').split(' ')[0];
    const firstName = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();

    if (!phone) {
      console.log(`  ✗ ${appt.id.slice(0, 10)}… — sem telefone`);
      continue;
    }

    try {
      await sendInitialQuestion(phone, firstName);
      sent++;
      console.log(`  ✓ Pergunta enviada para ${firstName} (${phone})`);

      // Mark sent in Worker KV (primary) + ER Clinic (best-effort)
      await fetch(`${WORKER_URL}/mark-sent`, {
        method: 'POST',
        headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointmentId: appt.id })
      }).catch(() => {});

      try { await markSent(appt.id); } catch {}

      // Anti-ban: delay 4–8 min entre mensagens
      if (sent < MAX_PER_RUN) {
        const delayMs = Math.floor(Math.random() * 240000) + 240000;
        console.log(`  ⏱ Aguardando ${Math.round(delayMs / 60000)}min…`);
        await randomDelay(240000, 480000);
      }
    } catch (err) {
      console.error(`  ✗ ${appt.id.slice(0, 10)}… — ${err.message}`);
    }
  }

  console.log(`Concluído. ${sent} pergunta(s) enviada(s).`);
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
