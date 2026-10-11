// Maszk Google-naptár → Terem 7 szinkron
// Naponta egyszer fut (vercel.json "crons"), illetve az admin oldal
// "Szinkronizálás most" gombjáról.
//
// Szükséges Vercel környezeti változók (Settings → Environment Variables):
//   SUPABASE_URL         – https://bzcqamsnziqnbroihjot.supabase.co
//   SUPABASE_SECRET_KEY  – Supabase "secret" kulcs (sb_secret_...) – SOHA ne kerüljön a böngészőbe
//   MASZK_ICAL_URL       – a Google-naptár titkos iCal címe (…/private-…/basic.ics)
//   CRON_SECRET          – tetszőleges hosszú véletlen szöveg (a Vercel ezzel hívja az időzítést)

import ical from 'node-ical';
import { createClient } from '@supabase/supabase-js';

const NAPOK_ELORE = 60;

export function esemenyekIcsbol(icsSzoveg, tol, ig) {
  const adat = ical.sync.parseICS(icsSzoveg);
  const ki = [];
  for (const ev of Object.values(adat)) {
    if (!ev || ev.type !== 'VEVENT') continue;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    let peldanyok;
    try {
      peldanyok = ical.expandRecurringEvent(ev, { from: tol, to: ig });
    } catch (e) {
      peldanyok = [];
    }
    for (const p of peldanyok) {
      if (p.isFullDay) continue; // egész napos bejegyzés (pl. verseny máshol) – nem teremfoglalás
      const kezdes = new Date(p.start);
      const veg = new Date(p.end || p.start);
      if (!(veg > kezdes)) continue;
      if (veg <= tol || kezdes >= ig) continue;
      const cim = typeof p.summary === 'object' && p.summary ? p.summary.val : p.summary;
      ki.push({ kezdes: kezdes.toISOString(), veg: veg.toISOString(), cim: String(cim || '').trim() });
    }
  }
  ki.sort((a, b) => a.kezdes.localeCompare(b.kezdes));
  return ki;
}

function valasz(res, kod, test) {
  res.statusCode = kod;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(test));
}

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, MASZK_ICAL_URL, CRON_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !MASZK_ICAL_URL) {
    return valasz(res, 500, { hiba: 'Hiányzó beállítás a Vercelen (SUPABASE_URL, SUPABASE_SECRET_KEY vagy MASZK_ICAL_URL).' });
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- Ki hívhatja: a Vercel időzítője, vagy bejelentkezett admin ---
  const auth = String(req.headers.authorization || '');
  let inditotta;
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) {
    inditotta = 'időzítés';
  } else {
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return valasz(res, 401, { hiba: 'Bejelentkezés szükséges.' });
    const { data: u, error: ue } = await db.auth.getUser(token);
    if (ue || !u || !u.user) return valasz(res, 401, { hiba: 'Lejárt bejelentkezés. Lépj ki és be újra.' });
    const { data: adm } = await db.from('adminok').select('user_id').eq('user_id', u.user.id);
    if (!adm || !adm.length) return valasz(res, 403, { hiba: 'Ehhez a fiókhoz nincs admin jog.' });
    inditotta = u.user.email || 'admin';
  }

  const tol = new Date();
  const ig = new Date(tol.getTime() + NAPOK_ELORE * 86400000);

  try {
    const r = await fetch(MASZK_ICAL_URL, { headers: { 'User-Agent': 'foglalas-szinkron' } });
    if (!r.ok) throw new Error(`A Google-naptár nem érhető el (HTTP ${r.status}). Ellenőrizd a MASZK_ICAL_URL címet.`);
    const szoveg = await r.text();
    if (!szoveg.includes('BEGIN:VCALENDAR')) throw new Error('A MASZK_ICAL_URL címen nem naptár van. A titkos iCal címet kell megadni.');

    const esemenyek = esemenyekIcsbol(szoveg, tol, ig);
    const { data, error } = await db.rpc('maszk_szinkron', {
      p_esemenyek: esemenyek, p_tol: tol.toISOString(), p_ig: ig.toISOString(), p_inditotta: inditotta,
    });
    if (error) throw new Error(error.message);
    return valasz(res, 200, { ok: true, ...data });
  } catch (e) {
    const uzenet = e && e.message ? e.message : String(e);
    await db.rpc('szinkron_hiba', { p_hiba: uzenet, p_inditotta: inditotta }).then(() => {}, () => {});
    return valasz(res, 500, { hiba: uzenet });
  }
}

