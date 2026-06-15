'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const ERCLINIC_KEY      = process.env.ERCLINIC_API_KEY;
const ERCLINIC_BASE     = 'https://erclinic.com.br';
const PROFISSIONAL_ID   = process.env.ERCLINIC_PROFISSIONAL_ID || 'a8b2f274ff2e37b46aa7dcce3c3014b2';
const EVO_URL           = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const EVO_KEY        = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCE   = process.env.EVOLUTION_INSTANCE;
const REVIEW_LINK    = 'https://g.page/r/CbIF9ryRK9q-EAI/review';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Returns current date in Brasília (UTC-3) as yyyy-mm-dd
function todayBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

// Returns current datetime in BRT as "yyyy-mm-dd HH:MM"
function nowBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// Only send between 8h–20h BRT (11h–23h UTC)
function inBusinessHours() {
  const h = new Date().getUTCHours();
  return h >= 11 && h < 23;
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
  // Remove qualquer coisa que não seja dígito
  const phone = rawPhone.replace(/\D/g, '');

  const message = [
    `Olá, ${firstName}! 😊`,
    '',
    `Obrigada pela consulta com a Dra. Juliany hoje.`,
    '',
    `Se puder, avalie nossa clínica no Google — leva menos de 1 minuto e nos ajuda muito:`,
    `👉 ${REVIEW_LINK}`,
    '',
    `Muito obrigada! 🙏`,
    `— Equipe Dra. Juliany`
  ].join('\n');

  const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: {
      apikey: EVO_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ number: phone, text: message })
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
    // Já enviamos antes? reminder_sent_date preenchido = sim
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

      // Pausa entre envios para não parecer spam
      await new Promise(r => setTimeout(r, 4000));
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
