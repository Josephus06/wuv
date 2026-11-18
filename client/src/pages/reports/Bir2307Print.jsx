import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import { useAuth } from '../../context/useAuth';

// BIR Form No. 2307, January 2018 (ENCS) -- Certificate of Creditable Tax Withheld at Source -- for
// one supplier and one quarter (asked 2026-11-05), opened from BIR Reports > BIR 2307 to Suppliers.
// The sheet copies the official form box for box on A4 so it prints as the certificate itself.
// Above it (not printed) everything on it can be checked and corrected first: the supplier's TIN /
// address as typed in Master Lists, the Payor, and the ATC of each line -- imported bills carry no
// withholding tax, so their ATC is suggested from the rate and must be confirmed here.
// A 2307 can cover every document of the quarter or only the ticked ones -- "2307 for this one"
// makes it a single document's, its period that document's month; the period is editable either way.
// Print needs can_print on /reports/bir-2307, and each print is logged as the 2307 issued.

const money = (v) => (Number(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const mdy = (iso) => (iso ? `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}` : '');

// "407-996-782-00001" -> ['407', '996', '782', '00001']: nine digits and a five-digit branch code.
function tinParts(tin) {
  const d = String(tin || '').replace(/\D/g, '');
  if (!d) return ['', '', '', ''];
  const branch = d.slice(9, 14);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.length > 9 ? branch.padStart(5, '0') : '00000'];
}

function Boxes({ value, n }) {
  const chars = String(value || '').padEnd(n, ' ').slice(0, n).split('');
  return <span className="f-boxes">{chars.map((c, i) => <span key={i} className="f-box">{c.trim()}</span>)}</span>;
}
function Tin({ value }) {
  const [a, b, c, d] = tinParts(value);
  return (
    <span className="f-tin">
      <Boxes value={a} n={3} /><span className="f-dash">-</span><Boxes value={b} n={3} /><span className="f-dash">-</span>
      <Boxes value={c} n={3} /><span className="f-dash">-</span><Boxes value={d} n={5} />
    </span>
  );
}
function DateBoxes({ iso }) {
  const v = mdy(iso);
  return <span className="f-tin"><Boxes value={v.slice(0, 2)} n={2} /><Boxes value={v.slice(2, 4)} n={2} /><Boxes value={v.slice(4)} n={4} /></span>;
}

// A source document's key: "Vendor Bill-123". ?doc= takes one or more (comma-separated) to open
// the 2307 for just those documents -- the Vendor Bill page links here that way.
const docKey = (d) => `${d.doc_type}-${d.id}`;
// The form's remaining blanks -- the tax agent / attorney's roll no. and its issue and expiry dates
// under each signature, and the payee's conforme -- typed here, empty unless filled.
const BLANK_EXTRA = {
  payor_agent: '', payor_issue: '', payor_expiry: '',
  conforme: '', payee_agent: '', payee_issue: '', payee_expiry: '',
};
const newManualLine = () => ({ atc: '', nature: '', months: ['', '', ''], tax: '' });
const DOCS_PER_PAGE = 10; // the document list is paged (asked 2026-11-05: 48 bills ran far down the page)
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthBounds = (iso) => {
  const y = Number(iso.slice(0, 4)); const m = Number(iso.slice(5, 7));
  return { from: `${iso.slice(0, 7)}-01`, to: `${iso.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` };
};

export default function Bir2307Print() {
  const { can } = useAuth();
  const mayPrint = can('/reports/bir-2307', 'can_print');
  const [params] = useSearchParams();
  const quarter = params.get('quarter');
  const payeeKey = params.get('payee');
  const onlyDocs = params.get('doc');
  // Create 2307 (asked 2026-11-18): a blank certificate typed by hand -- no documents behind it, so
  // Part III's lines (ATC, nature, each month's income, tax) are typed here too.
  const manual = params.get('manual') === '1';
  const [src, setSrc] = useState(null);
  const [f, setF] = useState(null); // what prints: period, payee, payor, the agent / conforme blanks
  const [sel, setSel] = useState([]); // keys of the documents on this certificate
  const [over, setOver] = useState({}); // a line's ATC / nature as changed here, by line key
  const [mlines, setMlines] = useState([newManualLine()]); // manual mode's Part III lines
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [printing, setPrinting] = useState(false);
  const [docPage, setDocPage] = useState(1);

  useEffect(() => {
    api.get('/reports/bir/2307/form', { params: manual ? { quarter, manual: 1 } : { quarter, payee: payeeKey } })
      .then(({ data }) => {
        setSrc(data);
        if (manual) {
          setF({ from: data.from, to: data.to, payee: { ...data.payee, foreign: '' }, payor: { ...data.payor }, extra: { ...BLANK_EXTRA } });
          document.title = `BIR 2307 ${data.quarter} - New`;
          return;
        }
        const wanted = onlyDocs ? onlyDocs.split(',').filter((k) => data.docs.some((d) => docKey(d) === k)) : [];
        const keys = wanted.length ? wanted : data.docs.map(docKey);
        // One document: the period is that document's month. Otherwise the quarter. Either can be changed.
        const one = wanted.length === 1 ? data.docs.find((d) => docKey(d) === wanted[0]) : null;
        if (one) setDocPage(Math.floor(data.docs.indexOf(one) / DOCS_PER_PAGE) + 1);
        setSel(keys);
        setF({
          ...(one ? monthBounds(one.date_created) : { from: data.from, to: data.to }),
          payee: { ...data.payee, foreign: '' },
          payor: { ...data.payor },
          extra: { ...BLANK_EXTRA },
        });
        document.title = `BIR 2307 ${data.quarter} - ${data.payee.name}`;
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not load this 2307.'));
  }, [quarter, payeeKey, onlyDocs, manual]);

  // Part III from the ticked documents: one line per ATC (no ATC even suggested: per rate), each
  // document's tax base under its month of the quarter. Manual: the typed lines, the tax worked out
  // at the ATC's rate unless one is typed.
  const lines = useMemo(() => {
    if (!src) return [];
    if (manual) {
      return mlines.map((m, i) => {
        const months = m.months.map((v) => r2(v));
        const total = r2(months.reduce((s, v) => s + v, 0));
        const rate = src.atc_options.find((a) => a.atc === m.atc)?.rate;
        const tax = m.tax !== '' ? r2(m.tax) : (rate != null ? r2(total * Number(rate) / 100) : 0);
        return { key: `m${i}`, atc: m.atc, nature: m.nature, rate: rate ?? null, suggested: false, months, total, tax };
      }).filter((l) => l.atc || l.nature || l.total || l.tax);
    }
    const map = new Map();
    for (const d of src.docs) {
      if (!sel.includes(docKey(d))) continue;
      const k = d.atc || `?${d.eff_rate}`;
      if (!map.has(k)) map.set(k, { key: k, atc: d.atc, nature: d.nature || '', rate: d.rate != null ? d.rate : d.eff_rate, suggested: false, months: [0, 0, 0], tax: 0 });
      const l = map.get(k);
      if (!l.nature && d.nature) l.nature = d.nature;
      if (d.atc_suggested) l.suggested = true;
      const mi = src.months.indexOf(d.date_created.slice(0, 7));
      if (mi >= 0) l.months[mi] += d.tax_base;
      l.tax += d.wtax_amount;
    }
    return [...map.values()]
      .map((l) => ({ ...l, ...(over[l.key] || {}), months: l.months.map(r2), total: r2(l.months.reduce((s, v) => s + v, 0)), tax: r2(l.tax) }))
      .sort((a, b) => (a.atc ? 0 : 1) - (b.atc ? 0 : 1) || String(a.atc).localeCompare(String(b.atc)));
  }, [src, sel, over, manual, mlines]);
  const totals = useMemo(() => ({
    months: [0, 1, 2].map((i) => r2(lines.reduce((s, l) => s + l.months[i], 0))),
    total: r2(lines.reduce((s, l) => s + l.total, 0)),
    tax: r2(lines.reduce((s, l) => s + l.tax, 0)),
  }), [lines]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t open this 2307</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!f) return <LoadingSpinner />;

  const set = (part, k, v) => setF((x) => ({ ...x, [part]: { ...x[part], [k]: v } }));
  const setLine = (key, patch) => setOver((o) => ({ ...o, [key]: { ...(o[key] || {}), ...patch } }));
  const pickAtc = (l, atc) => {
    const o = src.atc_options.find((a) => a.atc === atc);
    setLine(l.key, { atc, nature: o ? o.nature : l.nature, suggested: false });
  };
  const toggle = (k) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const onlyThis = (d) => { setSel([docKey(d)]); setF((x) => ({ ...x, ...monthBounds(d.date_created) })); };
  const allDocs = () => { setSel(src.docs.map(docKey)); setF((x) => ({ ...x, from: src.from, to: src.to })); };
  const chosen = src.docs.filter((d) => sel.includes(docKey(d)));
  const unconfirmed = lines.filter((l) => l.suggested).length;
  const noAtc = lines.filter((l) => !l.atc).length;
  const rows = Math.max(10, lines.length);
  const p = f.payor;
  const signLine = [p.signatory, p.signatory_title, p.signatory_tin ? `TIN ${p.signatory_tin}` : ''].filter(Boolean).join(' / ');
  const badPeriod = !f.from || !f.to || f.from > f.to;
  const x = f.extra;
  const setExtra = (k, v) => setF((o) => ({ ...o, extra: { ...o.extra, [k]: v } }));
  const setM = (i, patch) => setMlines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setMonth = (i, mi, v) => setMlines((ls) => ls.map((l, j) => (j === i ? { ...l, months: l.months.map((m, k) => (k === mi ? v : m)) } : l)));
  const pickManualAtc = (i, atc) => {
    const o = src.atc_options.find((a) => a.atc === atc);
    setM(i, { atc, ...(o ? { nature: o.nature } : {}) });
  };
  const canPrint = manual ? (lines.length > 0 && !!f.payee.name.trim()) : chosen.length > 0;

  async function print() {
    setPrinting(true); setNote('');
    try {
      await api.post('/reports/bir/2307/issued', manual
        ? {
          // Logged under its own key, apart from the quarter's computed payees, so a hand-made 2307
          // never shows a listed supplier as issued.
          quarter: src.quarter, payee_key: `manual:${(f.payee.tin || f.payee.name).trim()}`, supplier_id: null, payee_name: f.payee.name,
          income_total: totals.total, tax_total: totals.tax, period_from: f.from, period_to: f.to, doc_refs: 'Manual 2307',
        }
        : {
          quarter: src.quarter, payee_key: src.payee_key, supplier_id: src.supplier_id, payee_name: f.payee.name,
          income_total: totals.total, tax_total: totals.tax, period_from: f.from, period_to: f.to,
          doc_refs: chosen.length === src.docs.length ? null : chosen.map((d) => d.doc_no).join(', '),
        });
    } catch (e) {
      setNote(e.response?.data?.error || 'Printed, but it could not be recorded as issued.');
    }
    setPrinting(false);
    window.print();
  }

  return (
    <div className="f2307">
      <style>{`
        .f2307 { background: #f1f5f9; padding: 16px 0 40px; }
        .f-panel { max-width: 210mm; margin: 0 auto 14px; background: #fff; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 4px rgba(0,0,0,.15);
          font: 13px/1.5 system-ui, 'Segoe UI', sans-serif; color: #1f2937; }
        .f-panel h3 { margin: 0 0 8px; font-size: 14px; }
        .f-panel .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; }
        .f-panel label { display: block; font-size: 11px; color: #64748b; }
        .f-panel input, .f-panel select { width: 100%; box-sizing: border-box; padding: 4px 6px; font: inherit; border: 1px solid #cbd5e1; border-radius: 4px; }
        .f-panel table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        .f-panel td, .f-panel th { padding: 4px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; font-size: 12px; }
        /* the app's global th/td nowrap ran long document references past the panel's edge */
        .f-panel td { white-space: normal; overflow-wrap: anywhere; }
        .f-warn { color: #b45309; }
        .f-bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }

        .f-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 4mm 8mm 3mm; box-sizing: border-box; background: #fff; color: #000;
          font-family: Arial, Helvetica, sans-serif; font-size: 7.5pt; line-height: 1.2; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
        .f-top { display: grid; grid-template-columns: 30mm 1fr 30mm; align-items: center; }
        .f-use { font-size: 6.5pt; border: 0.3mm solid #000; padding: 0.5mm 1mm; width: max-content; background: #d9d9d9; }
        .f-rep { display: flex; align-items: center; justify-content: center; gap: 3mm; text-align: center; font-weight: 700; font-size: 7.5pt; line-height: 1.25; }
        .f-seal { width: 14.4mm; height: 11.5mm; }
        .f-frame { border: 0.4mm solid #000; }
        .f-head { display: grid; grid-template-columns: 38mm 1fr 56mm; border-bottom: 0.4mm solid #000; }
        .f-head > div { padding: 1mm 2mm; }
        .f-formno { border-right: 0.4mm solid #000; text-align: center; }
        .f-formno .n { font-size: 22pt; font-weight: 800; line-height: 1; }
        .f-title { text-align: center; font-size: 15pt; font-weight: 700; display: flex; align-items: center; justify-content: center; line-height: 1.15; }
        .f-code { border-left: 0.4mm solid #000; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-end; font-size: 6.5pt; }
        /* The official form's own PDF417 barcode and BIR seal, taken from BIR's fillable 2307 (Jan 2018
           ENCS v3) at the size they print there -- 53.0 x 10.5 mm and 14.4 x 11.5 mm (2026-11-18). The
           barcode is the same on every blank 2307; pixelated keeps its modules sharp for a scanner. */
        .f-bars { width: 53mm; height: 10.5mm; image-rendering: pixelated; image-rendering: crisp-edges; margin-bottom: 0.6mm; }
        .f-row { display: flex; align-items: center; gap: 2mm; padding: 0.6mm 2mm; border-bottom: 0.3mm solid #000; }
        .f-row.tall { flex-direction: column; align-items: stretch; gap: 0.4mm; }
        .f-num { font-weight: 700; margin-right: 1mm; }
        .f-hint { font-style: italic; }
        .f-part { text-align: center; font-weight: 700; background: #bfbfbf; border-bottom: 0.3mm solid #000; padding: 0.6mm; }
        .f-line { border: 0.3mm solid #000; min-height: 4mm; padding: 0.6mm 1.5mm; font-size: 8.5pt; font-weight: 700; display: flex; align-items: center; }
        .f-addr { display: grid; grid-template-columns: 1fr 22mm; gap: 2mm; align-items: end; }
        .f-boxes { display: inline-flex; border: 0.3mm solid #000; background: #fff; }
        .f-box { width: 3.4mm; height: 4.2mm; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5pt; font-weight: 700; }
        .f-box + .f-box { border-left: 0.15mm solid #999; }
        .f-tin { display: inline-flex; align-items: center; gap: 1.2mm; }
        .f-dash { font-weight: 700; background: #bfbfbf; padding: 0 0.6mm; }
        /* The app's global table rules (index.css: th, td { white-space: nowrap; padding: 9px 12px; ... },
           tbody tr:hover) would run the long BIR labels across the columns -- every one restated here. */
        .f-t { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5pt; color: #000; }
        .f-t th, .f-t td { border: 0.3mm solid #000; padding: 0.2mm 1mm; white-space: normal; overflow-wrap: break-word;
          text-align: left; vertical-align: middle; line-height: 1.15; color: #000; background: #fff; }
        .f-t tbody tr:hover { background: none; }
        .f-t th { font-weight: 700; text-align: center; background: #d9d9d9; font-size: 7pt; }
        .f-t td { height: 3.1mm; font-size: 7.5pt; }
        .f-t td.amt { text-align: right; font-weight: 700; white-space: nowrap; }
        .f-t td.nat { font-size: 5.6pt; line-height: 1.1; }
        .f-t td.atc { text-align: center; font-weight: 700; }
        .f-t tr.tot td { font-weight: 700; background: #d9d9d9; }
        .f-t tr.sec td { font-weight: 700; background: #d9d9d9; font-size: 7pt; }
        .f-t .shade { background: #d9d9d9; }
        .f-decl { padding: 0.8mm 2mm; text-align: justify; font-size: 6.5pt; border-bottom: 0.3mm solid #000; }
        .f-sign { height: 6.5mm; display: flex; align-items: flex-end; justify-content: center; font-weight: 700; font-size: 8.5pt; padding-bottom: 0.5mm; }
        .f-signlbl { text-align: center; background: #d9d9d9; border-top: 0.3mm solid #000; border-bottom: 0.3mm solid #000; padding: 0.5mm; font-size: 7pt; }
        .f-agent { display: grid; grid-template-columns: 36mm 1fr auto auto auto auto; gap: 2mm; align-items: center; padding: 0.5mm 2mm; font-size: 6.5pt; border-bottom: 0.3mm solid #000; }
        .f-agent .blank { border: 0.3mm solid #000; height: 4.2mm; }
        .f-agentno { display: flex; align-items: center; padding: 0 1mm; font-size: 8pt; font-weight: 700; }
        .f-conf { text-align: center; font-weight: 700; background: #bfbfbf; border-bottom: 0.3mm solid #000; padding: 0.5mm; }
        .f-note { font-size: 6.5pt; margin-top: 1mm; }
        @media print {
          html, body, #root, .f2307 { background: #fff !important; }
          .f2307 { padding: 0; }
          .f-no-print { display: none !important; }
          .f-sheet { box-shadow: none; margin: 0; min-height: 0; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="f-panel f-no-print">
        <div className="f-bar">
          <div>
            <strong>BIR 2307 · {manual ? 'New (manual)' : src.label}</strong>{f.payee.name ? ` — ${f.payee.name}` : ''}
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {manual ? 'Type every detail below; the form underneath fills in as you go.' : 'Check the details below. Changes here apply to this printout only.'}
            </div>
          </div>
          {mayPrint
            ? <button className="btn btn-primary" disabled={printing || !canPrint || badPeriod} onClick={print}>{printing ? 'Recording…' : 'Print 2307'}</button>
            : <span className="f-warn">You can view this 2307 but not print it.</span>}
        </div>
        {note && <div className="f-warn" style={{ marginTop: 6 }}>{note}</div>}

        {manual ? (
          <>
            <h3 style={{ marginTop: 12 }}>Period</h3>
            <div className="grid">
              <div><label>Period from</label><input type="date" value={f.from} onChange={(e) => setF((o) => ({ ...o, from: e.target.value }))} /></div>
              <div><label>Period to</label><input type="date" value={f.to} onChange={(e) => setF((o) => ({ ...o, to: e.target.value }))} /></div>
            </div>
            {badPeriod && <div className="f-warn" style={{ fontSize: 12, marginTop: 4 }}>The period needs a From date on or before its To date.</div>}
            {!f.payee.name.trim() && <div className="f-warn" style={{ fontSize: 12, marginTop: 4 }}>Type the payee&rsquo;s name (Part I).</div>}
            {!lines.length && <div className="f-warn" style={{ fontSize: 12, marginTop: 4 }}>Add at least one Part III line.</div>}
          </>
        ) : (<>
        <h3 style={{ marginTop: 12 }}>Period &amp; documents</h3>
        <div className="grid">
          <div><label>Period from</label><input type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} /></div>
          <div><label>Period to</label><input type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} /></div>
          <div style={{ alignSelf: 'end', fontSize: 12 }}>
            {chosen.length === src.docs.length
              ? <>All {src.docs.length} document{src.docs.length === 1 ? '' : 's'} of {src.label}.</>
              : <>{chosen.length} of {src.docs.length} documents. <a href="#all" onClick={(e) => { e.preventDefault(); allDocs(); }}>Use all</a></>}
          </div>
        </div>
        {badPeriod && <div className="f-warn" style={{ fontSize: 12, marginTop: 4 }}>The period needs a From date on or before its To date.</div>}
        <table>
          <thead><tr><th style={{ width: 28 }} /><th>Document</th><th>Date</th><th>ATC</th><th style={{ textAlign: 'right' }}>Tax base</th><th style={{ textAlign: 'right' }}>Withheld</th><th /></tr></thead>
          <tbody>
            {src.docs.slice((docPage - 1) * DOCS_PER_PAGE, docPage * DOCS_PER_PAGE).map((d) => (
              <tr key={docKey(d)} style={{ opacity: sel.includes(docKey(d)) ? 1 : 0.5 }}>
                <td><input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(docKey(d))} onChange={() => toggle(docKey(d))} aria-label={`Include ${d.doc_no}`} /></td>
                <td>{d.doc_type} {d.doc_no}{d.reference_no ? ` · ${d.reference_no}` : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{d.date_created}</td>
                <td>{d.atc || '—'}{d.atc_suggested ? ' (suggested)' : ''}</td>
                <td style={{ textAlign: 'right' }}>{money(d.tax_base)}</td>
                <td style={{ textAlign: 'right' }}>{money(d.wtax_amount)}</td>
                <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm" onClick={() => onlyThis(d)}>2307 for this one</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={docPage} totalPages={Math.ceil(src.docs.length / DOCS_PER_PAGE)} onChange={setDocPage} />
        {!chosen.length && <div className="f-warn" style={{ fontSize: 12, marginTop: 4 }}>Tick at least one document.</div>}
        </>)}

        {(unconfirmed > 0 || noAtc > 0 || !f.payee.tin || !p.tin || !p.name) && (
          <ul className="f-warn" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {unconfirmed > 0 && <li>{unconfirmed} line{unconfirmed === 1 ? '' : 's'} with an ATC suggested from the withholding rate. Confirm or change it below.</li>}
            {noAtc > 0 && <li>{noAtc} line{noAtc === 1 ? '' : 's'} with no ATC. Choose one below.</li>}
            {!f.payee.tin && <li>{manual ? 'Type the payee’s TIN below.' : 'The supplier has no TIN in Master Lists. Type it below, and add it to the supplier.'}</li>}
            {(!p.tin || !p.name) && <li>The Payor details are not set. Fill them in on BIR 2307 to Suppliers (Edit), or type them below.</li>}
          </ul>
        )}

        <h3 style={{ marginTop: 12 }}>Part I – Payee</h3>
        <div className="grid">
          <div><label>TIN</label><input value={f.payee.tin} onChange={(e) => set('payee', 'tin', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label>Payee&rsquo;s name</label><input value={f.payee.name} onChange={(e) => set('payee', 'name', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Registered address</label><input value={f.payee.address} onChange={(e) => set('payee', 'address', e.target.value)} /></div>
          <div><label>ZIP code</label><input value={f.payee.zip} onChange={(e) => set('payee', 'zip', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label>Foreign address, if applicable</label><input value={f.payee.foreign} onChange={(e) => set('payee', 'foreign', e.target.value)} /></div>
        </div>

        <h3 style={{ marginTop: 12 }}>Part II – Payor</h3>
        <div className="grid">
          <div><label>TIN</label><input value={p.tin} onChange={(e) => set('payor', 'tin', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label>Payor&rsquo;s name</label><input value={p.name} onChange={(e) => set('payor', 'name', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Registered address</label><input value={p.address} onChange={(e) => set('payor', 'address', e.target.value)} /></div>
          <div><label>ZIP code</label><input value={p.zip} onChange={(e) => set('payor', 'zip', e.target.value)} /></div>
          <div><label>Signatory</label><input value={p.signatory} onChange={(e) => set('payor', 'signatory', e.target.value)} /></div>
          <div><label>Title</label><input value={p.signatory_title} onChange={(e) => set('payor', 'signatory_title', e.target.value)} /></div>
          <div><label>Signatory TIN</label><input value={p.signatory_tin} onChange={(e) => set('payor', 'signatory_tin', e.target.value)} /></div>
        </div>

        {manual ? (<>
        <h3 style={{ marginTop: 12 }}>Part III – Income payments and tax withheld</h3>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>ATC</th><th>Nature of income payment</th>
              <th style={{ textAlign: 'right', width: 95 }}>1st month</th><th style={{ textAlign: 'right', width: 95 }}>2nd month</th>
              <th style={{ textAlign: 'right', width: 95 }}>3rd month</th><th style={{ textAlign: 'right', width: 95 }}>Tax withheld</th><th style={{ width: 28 }} />
            </tr>
          </thead>
          <tbody>
            {mlines.map((m, i) => {
              const l = lines.find((y) => y.key === `m${i}`);
              return (
                <tr key={i}>
                  <td>
                    <select value={m.atc} onChange={(e) => pickManualAtc(i, e.target.value)}>
                      <option value="">— choose —</option>
                      {src.atc_options.map((o) => <option key={o.id} value={o.atc}>{o.atc} · {o.rate}%</option>)}
                    </select>
                  </td>
                  <td><input value={m.nature} onChange={(e) => setM(i, { nature: e.target.value })} /></td>
                  {[0, 1, 2].map((mi) => (
                    <td key={mi}><input type="number" step="0.01" style={{ textAlign: 'right' }} value={m.months[mi]} onChange={(e) => setMonth(i, mi, e.target.value)} /></td>
                  ))}
                  <td>
                    <input type="number" step="0.01" style={{ textAlign: 'right' }} value={m.tax}
                      placeholder={l && l.tax ? l.tax.toFixed(2) : ''} title="Left blank, it is the total at the ATC's rate"
                      onChange={(e) => setM(i, { tax: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" aria-label="Remove line" disabled={mlines.length === 1}
                      onClick={() => setMlines((ls) => ls.filter((_, j) => j !== i))}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setMlines((ls) => [...ls, newManualLine()])}>+ Add line</button>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Tax withheld left blank is worked out at the ATC&rsquo;s rate (shown greyed).</div>
        </>) : (<>
        <h3 style={{ marginTop: 12 }}>Part III – ATC per line</h3>
        <table>
          <thead><tr><th style={{ width: 170 }}>ATC</th><th>Nature of income payment</th><th style={{ textAlign: 'right' }}>Income</th><th style={{ textAlign: 'right' }}>Tax</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>
                  <select value={l.atc} onChange={(e) => pickAtc(l, e.target.value)}>
                    <option value="">— choose —</option>
                    {src.atc_options.map((o) => <option key={o.id} value={o.atc}>{o.atc} · {o.rate}%</option>)}
                    {l.atc && !src.atc_options.some((o) => o.atc === l.atc) && <option value={l.atc}>{l.atc}</option>}
                  </select>
                  <div style={{ fontSize: 11, color: '#64748b' }}>
                    Withheld at {l.rate != null ? `${Number(l.rate)}%` : '?'}{l.suggested && <span className="f-warn"> · suggested</span>}
                  </div>
                </td>
                <td><input value={l.nature} onChange={(e) => setLine(l.key, { nature: e.target.value })} /></td>
                <td style={{ textAlign: 'right' }}>{money(l.total)}</td>
                <td style={{ textAlign: 'right' }}>{money(l.tax)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </>)}

        <h3 style={{ marginTop: 12 }}>Signatures – tax agent &amp; conforme</h3>
        <div className="grid">
          <div><label>Payor&rsquo;s tax agent accreditation / attorney&rsquo;s roll no.</label><input value={x.payor_agent} onChange={(e) => setExtra('payor_agent', e.target.value)} /></div>
          <div><label>Date of issue</label><input type="date" value={x.payor_issue} onChange={(e) => setExtra('payor_issue', e.target.value)} /></div>
          <div><label>Date of expiry</label><input type="date" value={x.payor_expiry} onChange={(e) => setExtra('payor_expiry', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Conforme – payee&rsquo;s signatory (name / title / TIN)</label><input value={x.conforme} onChange={(e) => setExtra('conforme', e.target.value)} /></div>
          <div><label>Payee&rsquo;s tax agent accreditation / attorney&rsquo;s roll no.</label><input value={x.payee_agent} onChange={(e) => setExtra('payee_agent', e.target.value)} /></div>
          <div><label>Date of issue</label><input type="date" value={x.payee_issue} onChange={(e) => setExtra('payee_issue', e.target.value)} /></div>
          <div><label>Date of expiry</label><input type="date" value={x.payee_expiry} onChange={(e) => setExtra('payee_expiry', e.target.value)} /></div>
        </div>

      </div>

      <div className="f-sheet">
        <div className="f-top">
          <div className="f-use">For BIR&nbsp;&nbsp;BCS/<br />Use Only&nbsp;Item:</div>
          <div className="f-rep"><img className="f-seal" src="/bir/bir-seal.png" alt="" /><div>Republic of the Philippines<br />Department of Finance<br />Bureau of Internal Revenue</div></div>
          <div />
        </div>
        <div className="f-frame" style={{ marginTop: 1.5 + 'mm' }}>
          <div className="f-head">
            <div className="f-formno">BIR Form No.<div className="n">2307</div>January 2018 (ENCS)</div>
            <div className="f-title">Certificate of Creditable Tax<br />Withheld at Source</div>
            <div className="f-code"><img className="f-bars" src="/bir/bir-2307-barcode.png" alt="" />2307 01/18ENCS</div>
          </div>
          <div className="f-row" style={{ fontSize: '6.5pt', padding: '0.4mm 2mm' }}>Fill in all applicable spaces. Mark all appropriate boxes with an &ldquo;X&rdquo;.</div>
          <div className="f-row">
            <span><span className="f-num">1</span>For the Period</span>
            <span style={{ marginLeft: '10mm' }}>From</span> <DateBoxes iso={f.from} /> <span className="f-hint">(MM/DD/YYYY)</span>
            <span style={{ marginLeft: '12mm' }}>To</span> <DateBoxes iso={f.to} /> <span className="f-hint">(MM/DD/YYYY)</span>
          </div>

          <div className="f-part">Part I – Payee Information</div>
          <div className="f-row"><span style={{ width: '62mm' }}><span className="f-num">2</span>Taxpayer Identification Number <span className="f-hint">(TIN)</span></span><Tin value={f.payee.tin} /></div>
          <div className="f-row tall">
            <span><span className="f-num">3</span>Payee&rsquo;s Name <span className="f-hint">(Last Name, First Name, Middle Name for Individual OR Registered Name for Non-Individual)</span></span>
            <div className="f-line">{f.payee.name}</div>
          </div>
          <div className="f-row tall">
            <div className="f-addr"><span><span className="f-num">4</span>Registered Address</span><span><span className="f-num">4A</span>ZIP Code</span></div>
            <div className="f-addr"><div className="f-line">{f.payee.address}</div><Boxes value={f.payee.zip} n={4} /></div>
          </div>
          <div className="f-row tall">
            <span><span className="f-num">5</span>Foreign Address, <span className="f-hint">if applicable</span></span>
            <div className="f-line">{f.payee.foreign}</div>
          </div>

          <div className="f-part">Part II – Payor Information</div>
          <div className="f-row"><span style={{ width: '62mm' }}><span className="f-num">6</span>Taxpayer Identification Number <span className="f-hint">(TIN)</span></span><Tin value={p.tin} /></div>
          <div className="f-row tall">
            <span><span className="f-num">7</span>Payor&rsquo;s Name <span className="f-hint">(Last Name, First Name, Middle Name for Individual OR Registered Name for Non-Individual)</span></span>
            <div className="f-line">{p.name}</div>
          </div>
          <div className="f-row tall">
            <div className="f-addr"><span><span className="f-num">8</span>Registered Address</span><span><span className="f-num">8A</span>ZIP Code</span></div>
            <div className="f-addr"><div className="f-line">{p.address}</div><Boxes value={p.zip} n={4} /></div>
          </div>

          <div className="f-part" style={{ borderBottom: 0 }}>Part III – Details of Monthly Income Payments and Taxes Withheld</div>
          <table className="f-t">
            <colgroup><col style={{ width: '25%' }} /><col style={{ width: '9%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} /><col style={{ width: '14%' }} /><col style={{ width: '16%' }} /></colgroup>
            <thead>
              <tr><th rowSpan={2}>Income Payments Subject to Expanded Withholding Tax</th><th rowSpan={2}>ATC</th><th colSpan={4}>AMOUNT OF INCOME PAYMENTS</th><th rowSpan={2}>Tax Withheld for the Quarter</th></tr>
              <tr><th>1st Month of the Quarter</th><th>2nd Month of the Quarter</th><th>3rd Month of the Quarter</th><th>Total</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => {
                const l = lines[i];
                return (
                  <tr key={i}>
                    <td className="nat">{l ? l.nature : ''}</td>
                    <td className="atc">{l ? l.atc : ''}</td>
                    <td className="amt">{l ? money(l.months[0]) : ''}</td>
                    <td className="amt">{l ? money(l.months[1]) : ''}</td>
                    <td className="amt">{l ? money(l.months[2]) : ''}</td>
                    <td className="amt">{l ? money(l.total) : ''}</td>
                    <td className="amt">{l ? money(l.tax) : ''}</td>
                  </tr>
                );
              })}
              <tr className="tot">
                <td>Total</td><td />
                <td className="amt">{money(totals.months[0])}</td><td className="amt">{money(totals.months[1])}</td>
                <td className="amt">{money(totals.months[2])}</td><td className="amt">{money(totals.total)}</td><td className="amt">{money(totals.tax)}</td>
              </tr>
              <tr className="sec"><td>Money Payments Subject to Withholding of Business Tax (Government &amp; Private)</td><td colSpan={6} className="shade" /></tr>
              {Array.from({ length: Math.max(3, 10 - Math.max(0, lines.length - 10)) }, (_, i) => <tr key={`b${i}`}><td /><td /><td /><td /><td /><td /><td /></tr>)}
              <tr className="tot"><td>Total</td><td /><td /><td /><td /><td /><td /></tr>
            </tbody>
          </table>

          <div className="f-decl">
            We declare under the penalties of perjury that this certificate has been made in good faith, verified by us, and to the best of our knowledge and belief, is true and
            correct, pursuant to the provisions of the National Internal Revenue Code, as amended, and the regulations issued under authority thereof. Further, we give our consent to
            the processing of our information as contemplated under the *Data Privacy Act of 2012 (R.A. No. 10173) for legitimate and lawful purposes.
          </div>
          <div className="f-sign">{signLine}</div>
          <div className="f-signlbl">Signature over Printed Name of Payor/Payor&rsquo;s Authorized Representative/Tax Agent<br /><span className="f-hint">(Indicate Title/Designation and TIN)</span></div>
          <div className="f-agent">
            <span>Tax Agent Accreditation No./ Attorney&rsquo;s Roll No. (if applicable)</span><div className="blank f-agentno">{x.payor_agent}</div>
            <span>Date of Issue<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso={x.payor_issue} />
            <span>Date of Expiry<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso={x.payor_expiry} />
          </div>
          <div className="f-conf">CONFORME:</div>
          <div className="f-sign">{x.conforme}</div>
          <div className="f-signlbl">Signature over Printed Name of Payee/Payee&rsquo;s Authorized Representative/Tax Agent<br /><span className="f-hint">(Indicate Title/Designation and TIN)</span></div>
          <div className="f-agent" style={{ borderBottom: 0 }}>
            <span>Tax Agent Accreditation No./ Attorney&rsquo;s Roll No. (if applicable)</span><div className="blank f-agentno">{x.payee_agent}</div>
            <span>Date of Issue<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso={x.payee_issue} />
            <span>Date of Expiry<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso={x.payee_expiry} />
          </div>
        </div>
        <div className="f-note">*NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)</div>
      </div>
    </div>
  );
}
