'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const ERCLINIC_KEY      = process.env.ERCLINIC_API_KEY;
const ERCLINIC_BASE     = 'https://erclinic.com.br';
const PROFISSIONAL_ID   = process.env.ERCLINIC_PROFISSIONAL_ID || 'a8b2f274ff2e37b46aa7dcce3c3014b2';
const EVO_URL           = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const EVO_KEY           = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCE      = process.env.EVOLUTION_INSTANCE;
const REVIEW_LINK       = 'https://g.page/r/CbIF9ryRK9q-EAI/review';

// Anti-ban: max messages per run (never spam in bulk)
const MAX_PER_RUN = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Random delay between min–max ms (human-like pacing)
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
      observation: 'Avaliação Google enviada via automação.'
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`markSent ${id.slice(0, 8)}… → ${res.status}: ${txt}`);
  }
}

// ── Evolution API (WhatsApp) ─────────────────────────────────────────────────

async function sendWhatsApp(rawPhone, firstName) {
  const phone = rawPhone.replace(/\D/g, '');

  const message = [
    `Olá, ${firstName}! 🙂`,
    '',
    `Agradeço pela confiança em meu atendimento. Sua opinião é muito importante para que eu possa continuar melhorando e oferecendo a melhor experiência possível.`,
    '',
    `Se puder, reserve um minutinho para avaliar sua consulta no Google através do link abaixo:`,
    '',
    REVIEW_LINK,
    '',
    `Muito obrigada!`
  ].join('\n');

  // Simulate typing indicator before sending (looks human, avoids spam detection)
  await fetch(`${EVO_URL}/chat/sendPresence/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: phone, options: { presence: 'composing', delay: 3000 } })
  }).catch(() => {}); // non-fatal — just best-effort

  // Wait for "typing" to feel natural (3–6s)
  await randomDelay(3000, 6000);

  const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: {
      apikey: EVO_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      number: phone,
      text: message,
      options: { delay: 1200 }  // Evolution API internal delay before delivery
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Evolution API → ${res.status}: ${txt}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Modo teste: envia mensagem direta sem consultar ER Clinic
  if (process.env.TEST_PHONE) {
    const phone = process.env.TEST_PHONE.replace(/\D/g, '');
    console.log(`[TESTE] Enviando mensagem de teste para ${phone}…`);
    await sendWhatsApp(phone, 'Teste');
    console.log(`[TESTE] Mensagem enviada com sucesso!`);
    return;
  }

  if (!inBusinessHours()) {
    console.log('Fora do horário comercial (8h–20h BRT). Nada a fazer.');
    return;
  }

  const today = todayBRT();
  console.log(`[${new Date().toISOString()}] Verificando atendimentos de ${today}…`);

  const data = await erclinicGet('/v2/api/publica/agenda/appointments/list', {
    status: 'ATENDIDO',
    date_min: today,
    date_max: today,
    profissional_id: PROFISSIONAL_ID
  });

  const appointments = data.content || [];
  console.log(`${appointments.length} atendimento(s) encontrado(s) hoje.`);

  let sent = 0;

  for (const appt of appointments) {
    if (sent >= MAX_PER_RUN) {
      console.log(`  ⚠ Limite de ${MAX_PER_RUN} mensagens/execução atingido. Restantes serão enviados na próxima rodada.`);
      break;
    }

    if (appt.reminder_sent_date) {
      console.log(`  ↷ ${appt.id.slice(0, 10)}… — avaliação já enviada`);
      continue;
    }

    const phone = appt.patient_cel_phone || appt.patient_phone;
    const firstName = (appt.patient_name || 'paciente').split(' ')[0];

    if (!phone) {
      console.log(`  ✗ ${appt.id.slice(0, 10)}… — sem telefone`);
      continue;
    }

    try {
      await sendWhatsApp(phone, firstName);
      await markSent(appt.id);
      sent++;
      console.log(`  ✓ Enviado para ${firstName} (${phone})`);

      // Anti-ban: delay humano aleatório entre mensagens (4–8 min)
      // Nunca disparar em rajada — parecer humano é fundamental
      if (sent < MAX_PER_RUN) {
        const delayMs = Math.floor(Math.random() * 240000) + 240000; // 4–8 min
        console.log(`  ⏱ Aguardando ${Math.round(delayMs / 60000)}min antes do próximo envio…`);
        await randomDelay(240000, 480000);
      }
    } catch (err) {
      console.error(`  ✗ ${appt.id.slice(0, 10)}… — ${err.message}`);
    }
  }

  console.log(`Concluído. ${sent} pedido(s) de avaliação enviado(s).`);
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
