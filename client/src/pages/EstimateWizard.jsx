import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import RepeatWorkPanel from '../components/RepeatWorkPanel';
import EntityPicker from '../components/EntityPicker';
import NstdjoPicker from '../components/NstdjoPicker';
import { computeAutoPricing } from '../utils/costing';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';

import { displayAuditTime } from '../utils/dates';
import { headerDepartmentError } from '../utils/requireDepartment';
import ItemUomSelect from '../components/ItemUomSelect';

const STEPS = ['Customer and Estimate', 'Job Orders', 'Billing', 'Completed'];

// Matches the real system's Job Order Units dropdown -- a fixed list, not a
// free-text/lookup field.
const UNIT_OPTIONS = ['PC/S', 'SET/S', 'BOX/ES', 'LOT/S', 'ROLL/S'];

const EMPTY_HEADER = {
  date_created: new Date().toISOString().slice(0, 10),
  customer_id: '', contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '',
  blanket_po_id: '', blanket_po_memo: '', sales_rep_id: '', sales_division_id: '', office_location_id: '',
  contract_description: '', memo: '', shipping_address: '', has_multiple_shipping: false,
  production_lead_time: '', price_validity: '', order_confirmation_type: '', order_confirmation_ref: '',
  print_warranty: false, print_warranty_term: '', structure_warranty: false, structure_warranty_term: '',
  electrical_warranty: false, electrical_warranty_term: '',
  prepared_by_id: '', approved_by_id: '', credit_term: '', credit_limit: '', credit_balance: '',
  bill_to_contact_number: '', status: 'pending_supervisor_approval',
  subtotal: '', discount_total: '', net_of_tax: '', tax_total: '', total_amount: '', est_gp_rate: '', est_gp_amount: '',
};

const ORDER_CONFIRMATION_OPTIONS = ['PO#', 'PO# with Payment', 'Conforme', 'Payment'];

// What the reference number is actually called, per confirmation type. "Reference No." for
// all four would make the field say less than the dropdown above it already does.
const ORDER_CONFIRMATION_REF_LABEL = {
  'PO#': 'PO Number',
  'PO# with Payment': 'PO Number',
  Conforme: 'Conforme No.',
  Payment: 'Payment Reference',
};
const ORDER_CONFIRMATION_REF_PLACEHOLDER = {
  'PO#': 'e.g. PO-2026-0042',
  'PO# with Payment': 'e.g. PO-2026-0042',
  Conforme: 'e.g. CONF-118',
  Payment: 'e.g. OR-9931 / bank ref',
};

// PDF and images only: an attachment here is a scan of a commercial document, and letting
// spreadsheets or archives in turns the estimate into a general file dump. Kept in step with
// ESTIMATE_ATTACHMENT_TYPES in server/src/routes/estimates.js.
const ATTACHMENT_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|tiff))$/i;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const EMPTY_JO = {
  nstdjo_no: '', nstdjo_id: '', job_type_id: '', job_location_id: '', description: '', quantity: '', units: '',
  price_per_unit: '', subtotal: '', disc_percent: '', disc_per_unit: '', disc_amount: '', disc_price_per_unit: '',
  net_of_tax: '', tax_code_id: '', tax_amount: '', gross_amount: '', length: '', width: '', height: '', uom: '',
  shipping: '', remarks: '', memo: '', delivery_date: '', delivery_time: '', gp_rate: '', gp_amount: '',
  // Contingency is entered under the process list rather than as a column in the job order table,
  // so it is in this list only to be saved and loaded -- see JOB_ORDER_COLUMNS, which it is
  // deliberately absent from.
  contingency_percent: '', contingency_amount: '',
};

const EMPTY_PROC = {
  process_id: '', process_qty: '', process_uom: '', item_id: '', location_id: '', length: '', width: '',
  uom: '', qty: '', total: '', unit: '', process_price: '', process_disc_percent: '', process_disc_amount: '',
  disc_process_price: '', material_price: '', material_disc_percent: '', material_disc_amount: '',
  disc_material_price: '', net_of_tax: '', tax_amount: '', gross_amount: '',
  remarks: '', memo: '', gp_rate: '', process_cost: '', material_cost: '',
  total_cost: '', total_price: '',
};

// Money as it reads on the sheet. Only used by the contingency block; every other figure in this
// wizard is an input carrying its own raw value.
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
};

const JOB_ORDER_FIELDS = Object.keys(EMPTY_JO);
const PROCESS_FIELDS = Object.keys(EMPTY_PROC);

const JOB_ORDER_COLUMNS = [
  // Tagged from the Non-Standard Job Order module, not typed. The column still keys on
  // nstdjo_no because that is what it displays and prints; the tag itself is nstdjo_id.
  { key: 'nstdjo_no', label: 'NSTDJO #', type: 'picker-nstdjo' },
  { key: 'job_type_id', label: 'Job Type', type: 'picker-jobtype' },
  { key: 'job_location_id', label: 'Job Location', type: 'picker-location' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'units', label: 'Units', type: 'select-units' },
  { key: 'price_per_unit', label: 'Price/Unit', type: 'number', readOnly: true },
  { key: 'subtotal', label: 'Subtotal', type: 'number', readOnly: true },
  { key: 'disc_percent', label: 'Disc %', type: 'number' },
  { key: 'disc_per_unit', label: 'Disc/Unit', type: 'number' },
  { key: 'disc_amount', label: 'Disc Amt', type: 'number' },
  { key: 'disc_price_per_unit', label: 'Disc Price/Unit', type: 'number' },
  { key: 'net_of_tax', label: 'Net of Tax', type: 'number', readOnly: true },
  { key: 'tax_code_id', label: 'Tax Code', type: 'picker-tax' },
  { key: 'tax_amount', label: 'Tax Amt', type: 'number', readOnly: true },
  { key: 'gross_amount', label: 'Gross Amt', type: 'number', readOnly: true },
  { key: 'length', label: 'Length', type: 'number' },
  { key: 'width', label: 'Width', type: 'number' },
  { key: 'height', label: 'Height', type: 'number' },
  { key: 'uom', label: 'UOM', type: 'text' },
  { key: 'shipping', label: 'Shipping', type: 'number' },
  { key: 'remarks', label: 'Remarks', type: 'text' },
  { key: 'memo', label: 'Memo', type: 'text' },
  { key: 'delivery_date', label: 'Delivery Date', type: 'date' },
  { key: 'delivery_time', label: 'Delivery Time', type: 'time' },
  { key: 'gp_rate', label: 'GP Rate', type: 'number', readOnly: true },
  { key: 'gp_amount', label: 'GP Amount', type: 'number', readOnly: true },
];

// readOnly columns are computed by the pricing engine (or auto-fetched from the
// selected Process/Item's base unit) -- per the user's spec, the only fields a person
// types into on a process line are process_qty, length, width, qty, process_disc_percent,
// process_disc_amount, material_disc_percent, and material_disc_amount. Everything else
// is either a selection (Process/Item picker) or derived.
const PROCESS_COLUMNS = [
  { key: 'process_id', label: 'Process', type: 'picker-process' },
  { key: 'process_qty', label: 'Process Qty', type: 'number' },
  { key: 'process_uom', label: 'Process UOM', type: 'text', readOnly: true },
  { key: 'item_id', label: 'Item', type: 'picker-item' },
  // Where the process is done -- starts at the process's Default Location, required (2026-11-11).
  { key: 'location_id', label: 'Process Location *', type: 'picker-proc-location' },
  { key: 'length', label: 'Length', type: 'number' },
  { key: 'width', label: 'Width', type: 'number' },
  { key: 'uom', label: 'UOM', type: 'select-uom' },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'total', label: 'Total', type: 'number', readOnly: true },
  { key: 'unit', label: 'Unit', type: 'text', readOnly: true },
  { key: 'process_price', label: 'Process Price', type: 'number', readOnly: true },
  { key: 'process_disc_percent', label: 'Process Disc %', type: 'number' },
  { key: 'process_disc_amount', label: 'Process Disc Amt', type: 'number' },
  { key: 'disc_process_price', label: 'Disc Process Price', type: 'number', readOnly: true },
  { key: 'material_price', label: 'Material Price', type: 'number', readOnly: true },
  { key: 'material_disc_percent', label: 'Material Disc %', type: 'number' },
  { key: 'material_disc_amount', label: 'Material Disc Amt', type: 'number' },
  { key: 'disc_material_price', label: 'Disc Material Price', type: 'number', readOnly: true },
  { key: 'net_of_tax', label: 'Net of Tax', type: 'number', readOnly: true },
  { key: 'tax_amount', label: 'Tax Amt', type: 'number', readOnly: true },
  { key: 'gross_amount', label: 'Gross Amt', type: 'number', readOnly: true },
  { key: 'remarks', label: 'Remarks', type: 'text' },
  { key: 'memo', label: 'Memo', type: 'text' },
  { key: 'gp_rate', label: 'GP Rate', type: 'number', readOnly: true },
  { key: 'process_cost', label: 'Process Cost', type: 'number', readOnly: true },
  { key: 'material_cost', label: 'Material Cost', type: 'number', readOnly: true },
  { key: 'total_cost', label: 'Total Cost', type: 'number', readOnly: true },
  { key: 'total_price', label: 'Total Price', type: 'number', readOnly: true },
];

function toPayload(row, fields) {
  const payload = {};
  fields.forEach((f) => { payload[f] = row[f] === '' || row[f] === undefined ? null : row[f]; });
  return payload;
}

export default function EstimateWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isNew = !id;

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState('');
  // Files chosen before the estimate exists, plus anything a failed upload left behind.
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');

  const [estimateId, setEstimateId] = useState(id ? Number(id) : null);
  const [estimateNo, setEstimateNo] = useState('');
  const [header, setHeader] = useState(EMPTY_HEADER);
  const [jobOrders, setJobOrders] = useState([]);
  const [shippingAddresses, setShippingAddresses] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [contacts, setContacts] = useState([]);
  // Inline "new contact" panel. Saving it writes to the customer's contacts in Master Lists,
  // then selects it here -- same flow as the NSTDJO form.
  const [newContact, setNewContact] = useState(null);
  const [savingContact, setSavingContact] = useState(false);
  const [contactError, setContactError] = useState('');
  const [blanketPos, setBlanketPos] = useState([]);
  const [newPo, setNewPo] = useState('');
  const [newShipping, setNewShipping] = useState('');

  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [salesDivisions, setSalesDivisions] = useState([]);
  const [locations, setLocations] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [processesList, setProcessesList] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  // Allowed-material lists, cached per `${job_type_id}:${process_id}` pair. A pair with no
  // row defined is unrestricted, and is cached as null so it is not re-fetched on every render.
  const [allowedMaterials, setAllowedMaterials] = useState({});
  // Escape hatch on the Material picker: tick it to see the whole inventory even where the
  // pair is restricted. Anything chosen while it is on gets learned onto the pair.
  const [showAllMaterials, setShowAllMaterials] = useState(false);
  // Process chooser opened when a Job Type is picked on a job order line.
  const [processPicker, setProcessPicker] = useState(null); // { joIdx, jobTypeId, rows, selected:Set, loading }
  // A job order line only accepts processes once it has been saved, which needs Quantity and
  // Units too. Choices made before that are held here and applied the moment the line saves,
  // so picking the Job Type first -- the natural order -- does not lose the selection.
  const pendingProcesses = useRef({});
  const [units, setUnits] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [bracketsByProcess, setBracketsByProcess] = useState({});
  const [uomsByItem, setUomsByItem] = useState({});

  const jobOrdersRef = useRef(jobOrders);
  useEffect(() => { jobOrdersRef.current = jobOrders; }, [jobOrders]);
  const postingJobOrders = useRef(new Set());
  const postingProcesses = useRef(new Set());
  const uomsRef = useRef(uomsByItem);
  useEffect(() => { uomsRef.current = uomsByItem; }, [uomsByItem]);
  const bracketsRef = useRef(bracketsByProcess);
  useEffect(() => { bracketsRef.current = bracketsByProcess; }, [bracketsByProcess]);

  useEffect(() => { init(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any one of these requests failing used to leave the page on "Loading..." for good, with
  // nothing on screen to say which; now the failing request and its message are shown instead.
  async function init() {
    setLoading(true);
    setLoadError(null);
    try {
      await loadAll();
    } catch (err) {
      const url = err?.config?.url || '';
      const status = err?.response?.status;
      const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Unknown error';
      setLoadError(`${url ? `${url} ` : ''}${status ? `(${status}) ` : ''}${msg}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadAll() {
    const [cust, emp, sd, loc, jt, proc, tax, itm, uom, pt] = await Promise.all([
      api.get('/customers'),
      api.get('/employees'),
      api.get('/lookups/sales-divisions'),
      api.get('/lookups/locations'),
      api.get('/job-types'),
      api.get('/lookups/processes'),
      api.get('/lookups/taxes'),
      // Service items flagged JO on the Service Items master belong on a process line here --
      // SERVICE LABOR, Layout Fee, the DESIGN build-up charges -- so they are asked for
      // alongside the materials. See the item_type note in routes/inventories.js.
      api.get('/inventory', { params: { include_jo_services: 1 } }),
      api.get('/lookups/units-of-measure'),
      api.get('/lookups/payment-terms'),
    ]);
    setCustomers(cust.data);
    setEmployees(emp.data);
    setSalesDivisions(sd.data);
    setLocations(loc.data);
    setJobTypes(jt.data);
    setProcessesList(proc.data);
    setTaxes(tax.data);
    setInventoryItems(itm.data);
    setUnits(uom.data);
    setPaymentTerms(pt.data);

    if (id) {
      await loadEstimate(Number(id));
    } else {
      // New estimate: Sales Rep/Prepared By default to the creating user, and Office
      // Location/Sales Division default to that user's own "Default Login Location"
      // branch (User Branches tab) -- their location goes straight to Office Location
      // (both are the same locations table); their branch's Department is matched by
      // name against Sales Division (e.g. a user branched to "Support" gets Sales
      // Division "Support" pre-selected) since those are two separate lookup tables
      // with no direct FK between them.
      const overrides = {};
      if (user?.employee_id) {
        overrides.sales_rep_id = user.employee_id;
        overrides.prepared_by_id = user.employee_id;
      }
      if (user?.default_branch?.location_id) {
        overrides.office_location_id = user.default_branch.location_id;
      }
      if (user?.default_branch?.department_name) {
        // Matched ignoring spaces, dashes and underscores: the department is "Sales - 1" and the
        // sales division "Sales-1", so an exact match never filled it for Sales-1 / Sales-3 users.
        const key = (v) => String(v || '').toLowerCase().replace(/[\s_-]+/g, '');
        const match = sd.data.find((s) => key(s.name) === key(user.default_branch.department_name));
        if (match) overrides.sales_division_id = match.id;
      }
      if (Object.keys(overrides).length) setHeader((h) => ({ ...h, ...overrides }));
    }
  }

  // Made by Replicate: its lines came across with no Delivery Date and no Job Location (asked
  // 2026-11-09), and both have to be put in again before NEXT on the job lines.
  const [isReplica, setIsReplica] = useState(false);

  async function loadEstimate(estId) {
    const { data } = await api.get(`/estimates/${estId}`);
    setEstimateId(data.id);
    setEstimateNo(data.estimate_no);
    setIsReplica(!!data.is_replica);
    const h = { ...EMPTY_HEADER };
    Object.keys(h).forEach((k) => { h[k] = typeof h[k] === 'boolean' ? !!data[k] : (data[k] ?? ''); });
    if (h.date_created) h.date_created = String(h.date_created).slice(0, 10);
    setHeader(h);
    const jobOrdersData = (data.jobOrders || []).map((jo) => ({ ...jo, processes: jo.processes || [] }));
    setJobOrders(jobOrdersData);
    const usedItemIds = [...new Set(jobOrdersData.flatMap((jo) => jo.processes.map((p) => p.item_id).filter(Boolean)))];
    usedItemIds.forEach((itemId) => ensureUomsLoaded(itemId));
    // Warm the allowed-material lists for rows that already exist, so reopening an estimate
    // restricts the picker straight away instead of only after the process is re-picked.
    jobOrdersData.forEach((jo) => jo.processes.forEach((pr) => ensureAllowedMaterials(jo.job_type_id, pr.process_id)));
    setShippingAddresses(data.shippingAddresses || []);
    await loadCustomerExtras(data.customer_id);
    const logs = await api.get(`/estimates/${estId}/audit-logs`);
    setAuditLogs(logs.data);
  }

  async function loadCustomerExtras(customerId) {
    if (!customerId) { setContacts([]); setBlanketPos([]); return; }
    const [custRes, poRes] = await Promise.all([
      api.get(`/customers/${customerId}`),
      api.get(`/blanket-pos?customer_id=${customerId}`),
    ]);
    setContacts(custRes.data.contacts || []);
    setBlanketPos(poRes.data);
  }

  function unitLabel(unitId) {
    return units.find((u) => u.id === unitId)?.title || '';
  }

  function setHeaderField(field, value) {
    setHeader((h) => ({ ...h, [field]: value }));
  }

  async function handleCustomerSelect(cust) {
    setHeader((h) => ({ ...h, customer_id: cust.id, contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '', blanket_po_id: '' }));
    setNewContact(null);
    await loadCustomerExtras(cust.id);
  }

  function handleContactSelect(contact) {
    setHeader((h) => ({
      ...h, contact_person_id: contact.id,
      contact_email: contact.email || '', contact_title: contact.title || '', contact_phone: contact.phone || '',
    }));
  }

  // Saves the new contact against the chosen customer, then selects it.
  async function saveNewContact() {
    if (!newContact?.contact_name.trim()) { setContactError('Contact name is required.'); return; }
    setSavingContact(true);
    setContactError('');
    try {
      const { data } = await api.post('/estimates/contacts', { ...newContact, customer_id: header.customer_id });
      setContacts((current) => [...current, data]);
      handleContactSelect(data);
      setNewContact(null);
    } catch (err) {
      setContactError(err.response?.data?.error || 'Could not save this contact.');
    } finally {
      setSavingContact(false);
    }
  }

  function buildHeaderPayload() {
    const payload = { ...header };
    ['customer_id', 'contact_person_id', 'blanket_po_id', 'sales_rep_id', 'sales_division_id', 'office_location_id', 'prepared_by_id', 'approved_by_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    ['credit_limit', 'credit_balance', 'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount', 'est_gp_rate', 'est_gp_amount']
      .forEach((k) => { payload[k] = payload[k] === '' ? null : payload[k]; });
    return payload;
  }

  // The Sales Division is required on every header save (the server refuses one without it).
  const divisionError = () => headerDepartmentError(header.sales_division_id, 'Sales Division');

  // A background save on blur: with no division it would only be refused, and the step buttons
  // already say why, so it is skipped rather than left to fail unseen.
  async function saveHeader() {
    if (!estimateId || divisionError()) return;
    await api.put(`/estimates/${estimateId}`, buildHeaderPayload());
  }

  // Files chosen on step 1 are held until the estimate exists -- attachments hang off an
  // estimate id, and on a new estimate there is not one yet. Uploaded on the way to step 2,
  // once the POST above has created it.
  function addPendingAttachments(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setAttachmentError('');
    const accepted = [];
    for (const f of files) {
      if (!ATTACHMENT_TYPES.test(f.type || '')) {
        setAttachmentError(`${f.name} is not a PDF or an image.`);
        continue;
      }
      if (f.size > ATTACHMENT_MAX_BYTES) {
        setAttachmentError(`${f.name} is ${(f.size / 1048576).toFixed(1)}MB — the limit is 10MB.`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length) setPendingAttachments((prev) => [...prev, ...accepted]);
  }

  async function uploadPendingAttachments(id) {
    if (!id || !pendingAttachments.length) return;
    const remaining = [];
    for (const file of pendingAttachments) {
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('unreadable'));
          reader.readAsDataURL(file);
        });
        await api.post(`/estimates/${id}/attachments`, { file_name: file.name, mime_type: file.type, data });
      } catch (err) {
        // Kept in the pending list so a failed upload can be retried, rather than vanishing
        // and leaving the estimate quietly short of the document someone attached.
        remaining.push(file);
        setAttachmentError(err.response?.data?.error || `Could not upload ${file.name}.`);
      }
    }
    setPendingAttachments(remaining);
  }

  async function goNextFromStep1(e) {
    e.preventDefault();
    setError('');
    const deptError = divisionError();
    if (deptError) { setError(deptError); return; }
    try {
      if (!estimateId) {
        const { data } = await api.post('/estimates', buildHeaderPayload());
        setEstimateId(data.id);
        setEstimateNo(data.estimate_no);
        await uploadPendingAttachments(data.id);
        navigate(`/estimates/${data.id}/edit`, { replace: true });
      } else {
        await api.put(`/estimates/${estimateId}`, buildHeaderPayload());
        await uploadPendingAttachments(estimateId);
      }
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function saveHeaderAndGoTo(nextStep) {
    setError('');
    const deptError = divisionError();
    if (deptError) { setError(deptError); return; }
    try {
      await api.put(`/estimates/${estimateId}`, buildHeaderPayload());
      if (nextStep === 4) {
        const logs = await api.get(`/estimates/${estimateId}/audit-logs`);
        setAuditLogs(logs.data);
      }
      setStep(nextStep);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  // --- Job order row helpers ---

  // A new line starts on line 1's Tax Code (asked 2026-10-07) -- an order is taxed one way throughout.
  function addJobOrderRow() {
    setJobOrders((prev) => [...prev, {
      _tempId: `draft-${Date.now()}`, id: null, ...EMPTY_JO, tax_code_id: prev[0]?.tax_code_id || EMPTY_JO.tax_code_id, processes: [],
    }]);
  }

  function updateJobOrderField(idx, field, value) {
    setJobOrders((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  // A refused line or process save used to fail silently: the screen kept the typed figures and
  // the refresh put the old ones back (EST-210951, 2026-10-15). Say so instead.
  async function commitJobOrderRow(idx, overrides = {}) {
    try {
      await commitJobOrderRowUnsafe(idx, overrides);
    } catch (err) {
      setError(`Line ${idx + 1} was NOT saved: ${err.response?.data?.error || err.message || 'save failed'}`);
    }
  }

  async function commitJobOrderRowUnsafe(idx, overrides = {}) {
    if (Object.keys(overrides).length) {
      setJobOrders((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], ...overrides };
        return next;
      });
    }
    const row = { ...jobOrdersRef.current[idx], ...overrides };
    if (!row) return;
    if (row.id) {
      await api.put(`/estimates/${estimateId}/job-orders/${row.id}`, toPayload(row, JOB_ORDER_FIELDS));
      return;
    }
    if (!row.job_type_id || !row.quantity || !row.units) return;
    // A POST may already be in flight for this still-draft row (rapid sequential edits each
    // trigger a commit on blur). Skip firing a duplicate; the in-flight one will pick up the
    // latest field values once it resolves, and the next blur's PUT will catch anything after that.
    if (postingJobOrders.current.has(idx)) return;
    postingJobOrders.current.add(idx);
    try {
      const { data } = await api.post(`/estimates/${estimateId}/job-orders`, toPayload(row, JOB_ORDER_FIELDS));
      // Merge in only the server-assigned identifiers — keep whatever the user has typed into
      // this row since the request was fired, rather than overwriting it with the stale payload.
      setJobOrders((prev) => prev.map((r, i) => (i === idx ? { ...r, id: data.id, line_no: data.line_no, processes: [] } : r)));
      const pending = pendingProcesses.current[idx];
      if (pending?.length) {
        delete pendingProcesses.current[idx];
        await applyProcessSelection(idx, pending);
      }
    } finally {
      postingJobOrders.current.delete(idx);
    }
  }

  // triggerKey mirrors the process-line pattern: editing Quantity or Gross Amount
  // derives Price/Unit = Gross Amount / Quantity (Gross Amount itself comes from the
  // process lines' Total Price, via recalcJobOrderSubtotal); editing Disc % or Disc Amt
  // derives the other one from the (auto-computed) Subtotal, same bidirectional link as
  // the process discount fields.
  async function recalcAndCommitJobOrder(idx, overrides = {}, triggerKey = null) {
    const current = { ...jobOrdersRef.current[idx], ...overrides };
    const computed = {};

    if (triggerKey === 'quantity') {
      Object.assign(computed, perUnitFor(current.quantity, current));
    }

    // Disc Amt is typed PER PIECE (the user's rule, 2026-10-01): 63.8888 off a 363.8888 piece makes
    // it 300.00, and 50 pieces Net 15,000.00. It is stored as the whole line's discount
    // (per piece x Qty) because every total, the SO and the invoice read disc_amount that way.
    if (triggerKey === 'disc_amount_unit') {
      const subtotal = Number(current.subtotal) || 0;
      const qty = Number(current.quantity) || 0;
      const perPiece = Number(current.disc_amount_unit) || 0;
      computed.disc_amount = Number((qty ? perPiece * qty : perPiece).toFixed(2));
      computed.disc_percent = subtotal ? Number((computed.disc_amount / subtotal * 100).toFixed(2)) : 0;
      computed.disc_amount_unit = null;
      Object.assign(computed, computeJobOrderTax(subtotal, computed.disc_amount, current.tax_code_id));
      Object.assign(computed, perUnitFor(current.quantity, { subtotal, ...computed }));
      const totalCost = Number((current.processes || []).reduce((s, p) => s + (Number(p.total_cost) || 0), 0).toFixed(2));
      computed.gp_amount = Number((computed.net_of_tax - totalCost).toFixed(2));
      computed.gp_rate = computed.net_of_tax ? Number((computed.gp_amount / computed.net_of_tax * 100).toFixed(2)) : null;
    }

    if (triggerKey === 'disc_percent' || triggerKey === 'disc_amount') {
      const subtotal = Number(current.subtotal) || 0;
      if (triggerKey === 'disc_percent') {
        computed.disc_amount = subtotal ? Number((subtotal * (Number(current.disc_percent) || 0) / 100).toFixed(2)) : 0;
      } else {
        computed.disc_percent = subtotal ? Number(((Number(current.disc_amount) || 0) / subtotal * 100).toFixed(2)) : 0;
      }
      const discAmount = computed.disc_amount ?? current.disc_amount;
      Object.assign(computed, computeJobOrderTax(subtotal, discAmount, current.tax_code_id));
      Object.assign(computed, perUnitFor(current.quantity, { subtotal, ...computed }));
      const totalCost = Number((current.processes || []).reduce((s, p) => s + (Number(p.total_cost) || 0), 0).toFixed(2));
      computed.gp_amount = Number((computed.net_of_tax - totalCost).toFixed(2));
      computed.gp_rate = computed.net_of_tax ? Number((computed.gp_amount / computed.net_of_tax * 100).toFixed(2)) : null;
    }

    await commitJobOrderRow(idx, { ...overrides, ...computed });
  }

  async function deleteJobOrderRow(idx) {
    const row = jobOrdersRef.current[idx];
    if (row.id) {
      if (!confirm(`Delete job order line #${row.line_no}?`)) return;
      await api.delete(`/estimates/${estimateId}/job-orders/${row.id}`);
    }
    // The server renumbers what is left 1..n; the screen follows, drafts (no number yet) included.
    setJobOrders((prev) => prev.filter((_, i) => i !== idx).map((r, i) => (r.line_no ? { ...r, line_no: i + 1 } : r)));
  }

  // Copy a line, processes and all, as the next line. A saved line is copied on the server and the
  // copy read back in the shape the estimate loads with; a draft never saved is copied as a draft.
  const [copyingJo, setCopyingJo] = useState(null);
  async function duplicateJobOrderRow(idx) {
    const row = jobOrdersRef.current[idx];
    if (!row.id) {
      setJobOrders((prev) => [...prev, {
        ...row, _tempId: `draft-${Date.now()}`, id: null, line_no: null,
        processes: (row.processes || []).map((p, i) => ({ ...p, id: null, _tempId: `draft-${Date.now()}-${i}` })),
      }]);
      return;
    }
    setCopyingJo(idx);
    try {
      const { data: created } = await api.post(`/estimates/${estimateId}/job-orders/${row.id}/duplicate`);
      const { data } = await api.get(`/estimates/${estimateId}`);
      const copy = (data.jobOrders || []).find((jo) => jo.id === created.id);
      if (copy) setJobOrders((prev) => [...prev, { ...copy, processes: copy.processes || [] }]);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not copy the line.');
    } finally {
      setCopyingJo(null);
    }
  }

  // --- Process row helpers ---

  // A process line needs its Process Qty, and its Material Qty when it carries an item, before the
  // next process is added or the estimate moves on (asked 2026-10-24). Returns "process 2 (Process
  // Qty)"-style labels for one job line.
  const qtyMissing = (v) => !(Number(v) > 0);
  function processQtyGaps(jo) {
    return (jo?.processes || []).map((p, pi) => {
      const miss = [qtyMissing(p.process_qty) && 'Process Qty', p.item_id && qtyMissing(p.qty) && 'Material Qty',
        p.process_id && !p.location_id && 'Process Location'].filter(Boolean);
      return miss.length ? `process ${pi + 1} (${miss.join(', ')})` : null;
    }).filter(Boolean);
  }
  function blockOnProcessGaps(joIdx) {
    const gaps = processQtyGaps(jobOrdersRef.current[joIdx]);
    if (!gaps.length) return false;
    setError(`Line ${joIdx + 1}: fill in ${gaps.join(', ')} before adding the next process.`);
    return true;
  }

  function addProcessRow(joIdx) {
    if (blockOnProcessGaps(joIdx)) return;
    setError('');
    setJobOrders((prev) => prev.map((r, i) => (i === joIdx
      ? { ...r, processes: [...(r.processes || []), { _tempId: `draft-${Date.now()}`, id: null, ...EMPTY_PROC }] }
      : r)));
  }

  function updateProcessField(joIdx, procIdx, field, value) {
    setJobOrders((prev) => {
      const next = [...prev];
      const jo = { ...next[joIdx] };
      const procs = [...(jo.processes || [])];
      procs[procIdx] = { ...procs[procIdx], [field]: value };
      jo.processes = procs;
      next[joIdx] = jo;
      return next;
    });
  }

  async function commitProcessRow(joIdx, procIdx, overrides = {}) {
    if (Object.keys(overrides).length) {
      setJobOrders((prev) => {
        const next = [...prev];
        const jo = { ...next[joIdx] };
        const procs = [...(jo.processes || [])];
        procs[procIdx] = { ...procs[procIdx], ...overrides };
        jo.processes = procs;
        next[joIdx] = jo;
        return next;
      });
    }
    const jo = jobOrdersRef.current[joIdx];
    const row = { ...jo?.processes?.[procIdx], ...overrides };
    if (!jo?.id || !row) return;
    // Process Location is required (2026-11-11). A process with no Default Location waits here,
    // unsaved, until one is picked on the line.
    if (row.process_id && !row.location_id) {
      setError(`Line ${joIdx + 1}, process ${procIdx + 1}: pick its Process Location -- this process has no Default Location. It is not saved until you do.`);
      return;
    }
    if (row.id) {
      try {
        await api.put(`/estimates/${estimateId}/job-orders/${jo.id}/processes/${row.id}`, toPayload(row, PROCESS_FIELDS));
      } catch (err) {
        setError(`Line ${joIdx + 1}, process ${procIdx + 1} was NOT saved: ${err.response?.data?.error || err.message || 'save failed'}`);
        return;
      }
      const updatedProcs = (jo.processes || []).map((p, pi) => (pi === procIdx ? row : p));
      await recalcJobOrderSubtotal(joIdx, updatedProcs);
    } else {
      if (!row.process_id) return;
      const key = `${joIdx}-${procIdx}`;
      if (postingProcesses.current.has(key)) return;
      postingProcesses.current.add(key);
      let data;
      try {
        ({ data } = await api.post(`/estimates/${estimateId}/job-orders/${jo.id}/processes`, toPayload(row, PROCESS_FIELDS)));
      } finally {
        postingProcesses.current.delete(key);
      }
      setJobOrders((prev) => prev.map((r, i) => {
        if (i !== joIdx) return r;
        const procs = [...(r.processes || [])];
        procs[procIdx] = { ...procs[procIdx], id: data.id, line_no: data.line_no };
        return { ...r, processes: procs };
      }));
      const updatedProcs = (jo.processes || []).map((p, pi) => (pi === procIdx ? { ...row, id: data.id, line_no: data.line_no } : p));
      await recalcJobOrderSubtotal(joIdx, updatedProcs);
    }
  }

  // Job Order Net of Tax = Subtotal - Disc Amt, Tax Amt = Net of Tax x the selected Tax
  // Code's rate (0 if none picked), Gross Amt = Net of Tax + Tax Amt -- computed here so
  // every trigger that can change subtotal, disc_amount, or tax_code_id (process-row
  // edits, Disc %/Amt edits, and picking a Tax Code) goes through the same formula.
  // The two per-unit figures, derived together so no caller can set one and forget the other --
  // which is exactly how Disc Price/Unit came to be blank on every estimate while Price/Unit was
  // filled in four different places.
  //
  //   Price/Unit      = Subtotal / Qty
  //   Disc Price/Unit = Price/Unit - Disc Amt (per piece) = Net of Tax / Qty
  //   Net of Tax      = Qty x Disc Price/Unit
  //
  // The user's rule (2026-10-01): the Disc Amt shown and typed is per piece -- see the
  // disc_amount_unit trigger. Stored disc_amount is the line's whole discount, so Net of Tax /
  // Qty is exactly Price/Unit less the per-piece discount. All tax-exclusive.
  function perUnitFor(quantity, { subtotal, net_of_tax: netOfTax }) {
    const qty = Number(quantity) || 0;
    if (!qty) return { price_per_unit: null, disc_price_per_unit: null };
    const sub = Number(subtotal || 0);
    return {
      price_per_unit: Number((sub / qty).toFixed(4)),
      disc_price_per_unit: Number((Number(netOfTax || 0) / qty).toFixed(4)),
    };
  }

  function computeJobOrderTax(subtotal, discAmount, taxCodeId) {
    const net_of_tax = Number((Number(subtotal || 0) - Number(discAmount || 0)).toFixed(2));
    const taxRate = taxCodeId ? Number(taxes.find((t) => t.id === Number(taxCodeId))?.rate) || 0 : 0;
    const tax_amount = Number((net_of_tax * taxRate / 100).toFixed(2));
    const gross_amount = Number((net_of_tax + tax_amount).toFixed(2));
    return { net_of_tax, tax_amount, gross_amount };
  }

  // Job Order Subtotal is the total of its process lines' Net of Tax -- recomputed
  // whenever a process line is added, edited, or removed. Net of Tax/Tax Amt/Gross Amt
  // then follow via computeJobOrderTax, and Price/Unit follows from the freshly computed
  // Gross Amount (Gross Amount / Quantity). If the job already has a Disc % set, Disc Amt
  // is refreshed to match the new subtotal (percent stays authoritative, same rule as the
  // process-line discount pairs).
  //
  // GP Amount = Net of Tax - (sum of process lines' Total Cost), GP Rate = GP Amount /
  // Net of Tax x 100 -- the same margin formula as each process line's own GP Rate, just
  // rolled up to the job-order's totals. Both are fully derived, never typed into.
  // CONTINGENCY sits between the process lines and the job order's Subtotal: the processes come to
  // a base, a buffer is added on top of it, and everything downstream -- discount, tax, Gross,
  // GP -- works from the result. On a base of 100 a contingency of 10% adds 10 and the Subtotal
  // becomes 110, which is what the real system's Total under the process list shows.
  //
  // The PERCENTAGE IS OF THE BASE, not of the inflated Subtotal. Taking it off the Subtotal would
  // make the figure refer to itself and 10% of 100 would no longer be 10.
  //
  // Percent and amount are each other's mirror and `trigger` says which one the person typed, so
  // the other is derived and the typed one is left exactly as entered. That is why both are
  // stored: entering an AMOUNT of 142.56 against a base of 10,357.45 gives 1.376401%, a number
  // nobody would type, and rounding it for storage would move the money on the next recalculation.
  function contingencyFor(base, jo, overrides = {}, trigger = null) {
    const pctRaw = overrides.contingency_percent ?? jo?.contingency_percent;
    const amtRaw = overrides.contingency_amount ?? jo?.contingency_amount;
    const pct = Number(pctRaw) || 0;
    const amt = Number(amtRaw) || 0;

    if (trigger === 'contingency_amount') {
      return {
        contingency_amount: amtRaw === '' || amtRaw == null ? null : Number(amt.toFixed(2)),
        contingency_percent: base ? Number(((amt / base) * 100).toFixed(6)) : null,
      };
    }
    if (trigger === 'contingency_percent') {
      return {
        contingency_percent: pctRaw === '' || pctRaw == null ? null : Number(pct.toFixed(6)),
        contingency_amount: base ? Number(((base * pct) / 100).toFixed(2)) : null,
      };
    }
    // Not typed into -- a process line changed underneath it. The percentage is what was agreed,
    // so it holds and the amount follows the new base.
    if (pct) return { contingency_percent: pct, contingency_amount: Number(((base * pct) / 100).toFixed(2)) };
    return { contingency_percent: pctRaw === '' || pctRaw == null ? null : pct, contingency_amount: amt ? Number(amt.toFixed(2)) : null };
  }

  async function recalcJobOrderSubtotal(joIdx, processes, extra = {}, trigger = null) {
    const base = Number(processes.reduce((s, p) => s + (Number(p.net_of_tax) || 0), 0).toFixed(2));
    const totalCost = Number(processes.reduce((s, p) => s + (Number(p.total_cost) || 0), 0).toFixed(2));
    const jo = jobOrdersRef.current[joIdx];
    const cont = contingencyFor(base, jo, extra, trigger);
    const subtotal = Number((base + (Number(cont.contingency_amount) || 0)).toFixed(2));
    const discPercent = Number(jo?.disc_percent) || 0;
    const qty = Number(jo?.quantity) || 0;
    const overrides = { subtotal, ...cont };
    if (discPercent) {
      overrides.disc_amount = Number((subtotal * discPercent / 100).toFixed(2));
    }
    const discAmount = overrides.disc_amount ?? jo?.disc_amount;
    Object.assign(overrides, computeJobOrderTax(subtotal, discAmount, jo?.tax_code_id));
    Object.assign(overrides, perUnitFor(qty, overrides));
    overrides.gp_amount = Number((overrides.net_of_tax - totalCost).toFixed(2));
    overrides.gp_rate = overrides.net_of_tax ? Number((overrides.gp_amount / overrides.net_of_tax * 100).toFixed(2)) : null;
    await commitJobOrderRow(joIdx, overrides);
  }

  // Typing in either contingency box. Routed through the same recalculation the process lines use
  // so the Subtotal, tax, Gross and GP all move together -- a contingency that changed the total
  // without changing the tax on it would be a quietly wrong quote.
  async function commitContingency(joIdx, key, value) {
    const jo = jobOrdersRef.current[joIdx];
    await recalcJobOrderSubtotal(joIdx, jo?.processes || [], { [key]: value }, key);
  }

  async function ensureBracketsLoaded(processId) {
    if (!processId) return [];
    if (bracketsRef.current[processId]) return bracketsRef.current[processId];
    const { data } = await api.get(`/processes/${processId}/cost-brackets`);
    bracketsRef.current = { ...bracketsRef.current, [processId]: data };
    setBracketsByProcess((prev) => ({ ...prev, [processId]: data }));
    return data;
  }

  // Each item's Unit dropdown on a process line is populated from that item's own
  // Unit of Measures list (Inventory item's "Unit of Measures" tab) -- fetched once per
  // item and cached, same pattern as ensureBracketsLoaded above.
  async function ensureUomsLoaded(itemId) {
    if (!itemId) return [];
    if (uomsRef.current[itemId]) return uomsRef.current[itemId];
    const { data } = await api.get(`/inventory/${itemId}/unit-of-measures`);
    uomsRef.current = { ...uomsRef.current, [itemId]: data };
    setUomsByItem((prev) => ({ ...prev, [itemId]: data }));
    return data;
  }

  // Auto-calculate process_cost/material_cost/total_cost/material_price/total_price/gross_amount
  // whenever the process, material, quantity, or size changes on a process line -- this is
  // what makes filling in qty + size "just generate the price" per the real system.
  //
  // triggerKey identifies which input field the user just blurred, and drives a
  // bidirectional link between each Disc % and its Disc Amt (Process and Material each
  // have their own independent pair):
  // - editing Disc % derives Disc Amt = price x pct / 100 (e.g. Price 100 + Disc % 10
  //   => Disc Amt 10)
  // - editing Disc Amt derives Disc % = amt / price x 100 (e.g. Price 100 + Disc Amt 10
  //   => Disc % 10)
  // Only the pair matching triggerKey is touched -- the other pair (and non-discount
  // fields) are left as whatever's already on the row.
  async function recalcAndCommitProcess(joIdx, procIdx, overrides = {}, triggerKey = null) {
    const current = { ...jobOrdersRef.current[joIdx]?.processes?.[procIdx], ...overrides };
    const brackets = await ensureBracketsLoaded(current.process_id);
    const inventory = current.item_id ? inventoryItems.find((i) => i.id === Number(current.item_id)) : null;
    const pricingArgs = {
      brackets, inventory, processQty: current.process_qty, qty: current.qty, length: current.length, width: current.width, uom: current.uom,
    };

    let discAmount = current.process_disc_amount;
    let materialDiscAmount = current.material_disc_amount;
    const discOverrides = {};

    const needsBase = ['process_disc_percent', 'process_disc_amount', 'material_disc_percent', 'material_disc_amount'].includes(triggerKey);
    if (needsBase) {
      const base = computeAutoPricing({ ...pricingArgs, discAmount, materialDiscAmount });
      if (triggerKey === 'process_disc_percent' && base.process_price) {
        discAmount = Number((base.process_price * (Number(current.process_disc_percent) || 0) / 100).toFixed(2));
        discOverrides.process_disc_amount = discAmount;
      }
      if (triggerKey === 'process_disc_amount' && base.process_price) {
        discOverrides.process_disc_percent = Number(((Number(current.process_disc_amount) || 0) / base.process_price * 100).toFixed(2));
      }
      if (triggerKey === 'material_disc_percent' && base.material_price) {
        materialDiscAmount = Number((base.material_price * (Number(current.material_disc_percent) || 0) / 100).toFixed(2));
        discOverrides.material_disc_amount = materialDiscAmount;
      }
      if (triggerKey === 'material_disc_amount' && base.material_price) {
        discOverrides.material_disc_percent = Number(((Number(current.material_disc_amount) || 0) / base.material_price * 100).toFixed(2));
      }
    }

    const computed = computeAutoPricing({ ...pricingArgs, discAmount, materialDiscAmount });
    await commitProcessRow(joIdx, procIdx, { ...overrides, ...discOverrides, ...computed });
  }

  async function deleteProcessRow(joIdx, procIdx) {
    const jo = jobOrdersRef.current[joIdx];
    const row = jo.processes[procIdx];
    if (row.id) {
      if (!confirm(`Delete process line #${row.line_no}?`)) return;
      await api.delete(`/estimates/${estimateId}/job-orders/${jo.id}/processes/${row.id}`);
    }
    setJobOrders((prev) => prev.map((r, i) => (i === joIdx
      ? { ...r, processes: r.processes.filter((_, pi) => pi !== procIdx).map((p, pi) => (p.line_no ? { ...p, line_no: pi + 1 } : p)) }
      : r)));
    const updatedProcs = jo.processes.filter((_, pi) => pi !== procIdx);
    await recalcJobOrderSubtotal(joIdx, updatedProcs);
  }

  // --- Reordering (▲ ▼) ---
  //
  // Swaps a line with its neighbour and renumbers the list on the server. Not offered while the
  // list holds an unsaved draft: in-flight saves find their row by position, so moving rows under
  // them would land a saved id on the wrong line.
  const [reordering, setReordering] = useState(false);
  const hasDraftLine = jobOrders.some((jo) => !jo.id || (jo.processes || []).some((p) => !p.id));

  function swapped(list, idx, dir) {
    const next = [...list];
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    return next.map((r, i) => ({ ...r, line_no: i + 1 }));
  }

  async function moveJobOrderRow(idx, dir) {
    const list = jobOrdersRef.current;
    if (idx + dir < 0 || idx + dir >= list.length) return;
    const next = swapped(list, idx, dir);
    setReordering(true);
    setJobOrders(next);
    try {
      await api.post(`/estimates/${estimateId}/job-orders/reorder`, { ids: next.map((r) => r.id) });
    } catch (err) {
      setJobOrders(list);
      setError(err.response?.data?.error || 'Could not move the line.');
    } finally {
      setReordering(false);
    }
  }

  async function moveProcessRow(joIdx, procIdx, dir) {
    const jo = jobOrdersRef.current[joIdx];
    const procs = jo.processes || [];
    if (procIdx + dir < 0 || procIdx + dir >= procs.length) return;
    const next = swapped(procs, procIdx, dir);
    setReordering(true);
    setJobOrders((prev) => prev.map((r, i) => (i === joIdx ? { ...r, processes: next } : r)));
    try {
      await api.post(`/estimates/${estimateId}/job-orders/${jo.id}/processes/reorder`, { ids: next.map((p) => p.id) });
    } catch (err) {
      setJobOrders((prev) => prev.map((r, i) => (i === joIdx ? { ...r, processes: procs } : r)));
      setError(err.response?.data?.error || 'Could not move the process line.');
    } finally {
      setReordering(false);
    }
  }

  // --- Shipping / Blanket PO ---

  async function addShipping() {
    if (!newShipping) return;
    const { data } = await api.post(`/estimates/${estimateId}/shipping-addresses`, { address: newShipping });
    setShippingAddresses((prev) => [...prev, data]);
    setNewShipping('');
  }

  async function removeShipping(addrId) {
    await api.delete(`/estimates/${estimateId}/shipping-addresses/${addrId}`);
    setShippingAddresses((prev) => prev.filter((a) => a.id !== addrId));
  }

  async function addBlanketPo() {
    if (!newPo || !header.customer_id) return;
    const { data } = await api.post('/blanket-pos', { customer_id: header.customer_id, po_number: newPo });
    setNewPo('');
    setBlanketPos((prev) => [data, ...prev]);
    setHeaderField('blanket_po_id', data.id);
  }

  // --- Cell renderers ---

  function jobOrderCell(col, row, idx) {
    const val = row[col.key] ?? '';
    if (col.type === 'picker-nstdjo') {
      return (
        <NstdjoPicker
          value={row.nstdjo_id || ''}
          selectedLabel={row.nstdjo_no || ''}
          // Both halves move together. The server rewrites the number from the record anyway,
          // so this only decides what the grid shows before the round trip.
          onSelect={(n) => commitJobOrderRow(idx, { nstdjo_id: n.id, nstdjo_no: n.nstdjo_no })}
          onClear={() => commitJobOrderRow(idx, { nstdjo_id: null, nstdjo_no: null })}
        />
      );
    }
    if (col.type === 'picker-jobtype') {
      return (
        <EntityPicker
          label="Job Type" items={jobTypes} value={val} getLabel={(j) => j.display_name}
          columns={[{ key: 'display_name', label: 'Display Name' }, { key: 'base_unit', label: 'Base Unit' }]}
          searchKeys={['display_name']}
          onSelect={async (j) => {
            await commitJobOrderRow(idx, { job_type_id: j.id });
            openProcessPicker(idx, j.id);
          }}
        />
      );
    }
    if (col.type === 'picker-location') {
      return (
        <EntityPicker
          label="Job Location" items={locations} value={val} getLabel={(l) => l.location_name}
          columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
          searchKeys={['location_name', 'location_code']}
          onSelect={(l) => commitJobOrderRow(idx, { job_location_id: l.id })}
        />
      );
    }
    if (col.type === 'picker-tax') {
      return (
        <EntityPicker
          label="Tax Code" items={taxes} value={val} getLabel={(t) => t.code}
          columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate %' }]}
          searchKeys={['code', 'name']}
          onSelect={(t) => {
            // Line 1's Tax Code is the order's: picking it re-taxes EVERY line the same way (VAT 12 on
            // line 1 makes them all VAT 12; 0 VAT makes them all 0 VAT -- asked 2026-10-07). Any other
            // line can still be changed on its own afterwards.
            const targets = idx === 0 ? jobOrdersRef.current.map((_, i) => i) : [idx];
            for (const i of targets) {
              const jo = jobOrdersRef.current[i];
              const computed = computeJobOrderTax(jo?.subtotal, jo?.disc_amount, t.id);
              Object.assign(computed, perUnitFor(jo?.quantity, { subtotal: jo?.subtotal, ...computed }));
              if (jo?.id || i === idx) commitJobOrderRow(i, { tax_code_id: t.id, ...computed });
              else Object.entries({ tax_code_id: t.id, ...computed }).forEach(([k, v]) => updateJobOrderField(i, k, v));
            }
          }}
        />
      );
    }
    if (col.type === 'select-units') {
      return (
        <select value={val} onChange={(e) => { updateJobOrderField(idx, col.key, e.target.value); commitJobOrderRow(idx, { units: e.target.value }); }}>
          <option value="">—</option>
          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      );
    }
    if (col.key === 'disc_amount') {
      const qty = Number(row.quantity) || 0;
      const perPiece = row.disc_amount_unit ?? (row.disc_amount === '' || row.disc_amount == null ? ''
        : Number((qty ? Number(row.disc_amount) / qty : Number(row.disc_amount)).toFixed(4)));
      return (
        <input
          type="number" step="0.0001" value={perPiece} title="Discount per piece"
          onChange={(e) => updateJobOrderField(idx, 'disc_amount_unit', e.target.value)}
          onBlur={() => (row.disc_amount_unit != null ? recalcAndCommitJobOrder(idx, {}, 'disc_amount_unit') : null)}
        />
      );
    }
    if (col.readOnly) {
      return <input value={val} readOnly tabIndex={-1} />;
    }
    const isPricingInput = col.key === 'quantity' || col.key === 'disc_percent' || col.key === 'disc_amount';
    return (
      <input
        type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : col.type === 'time' ? 'time' : 'text'}
        step={col.type === 'number' ? '0.0001' : undefined}
        value={val}
        onChange={(e) => updateJobOrderField(idx, col.key, e.target.value)}
        onBlur={() => (isPricingInput ? recalcAndCommitJobOrder(idx, {}, col.key) : commitJobOrderRow(idx))}
      />
    );
  }

  async function openProcessPicker(joIdx, jobTypeId) {
    if (!jobTypeId) return;
    if (blockOnProcessGaps(joIdx)) return;
    setError('');
    setProcessPicker({ joIdx, jobTypeId, rows: [], selected: new Set(), loading: true, search: '' });
    try {
      const { data } = await api.get(`/job-types/${jobTypeId}/processes`);
      setProcessPicker((prev) => (prev && prev.joIdx === joIdx ? { ...prev, rows: data, loading: false } : prev));
    } catch {
      setProcessPicker((prev) => (prev && prev.joIdx === joIdx ? { ...prev, rows: [], loading: false } : prev));
    }
  }

  // Appends one process row per chosen process and saves each. The whole row is passed as the
  // override rather than relying on jobOrdersRef, which only catches up after the next render.
  async function applyProcessSelection(joIdx, processIds) {
    if (!processIds.length) return;
    const jo = jobOrdersRef.current[joIdx];
    const startIdx = (jo?.processes || []).length;
    const newRows = processIds.map((pid, n) => {
      const proc = processesList.find((x) => x.id === pid);
      return {
        _tempId: `pick-${pid}-${startIdx + n}`, id: null, ...EMPTY_PROC,
        process_id: pid, process_uom: proc ? unitLabel(proc.base_unit_id) : '',
        location_id: proc?.default_location_id || '',
      };
    });
    setJobOrders((prev) => prev.map((r, i) => (i === joIdx
      ? { ...r, processes: [...(r.processes || []), ...newRows] }
      : r)));
    for (let n = 0; n < newRows.length; n++) {
      ensureAllowedMaterials(jo?.job_type_id, newRows[n].process_id);
      await recalcAndCommitProcess(joIdx, startIdx + n, newRows[n]);
    }
  }

  async function confirmProcessPicker() {
    if (!processPicker) return;
    const { joIdx, selected } = processPicker;
    const ids = [...selected];
    setProcessPicker(null);
    if (!ids.length) return;
    if (jobOrdersRef.current[joIdx]?.id) {
      await applyProcessSelection(joIdx, ids);
    } else {
      // Line not saved yet -- held until commitJobOrderRow creates it.
      pendingProcesses.current[joIdx] = [...(pendingProcesses.current[joIdx] || []), ...ids];
    }
  }

  function materialKey(jobTypeId, processId) { return `${jobTypeId}:${processId}`; }

  // Remember a material the pair had never been given, so it is offered as a defined material
  // next time this job type runs this process. Failure is deliberately quiet: the estimate
  // keeps the material either way, and a permission or network problem here must not block
  // the line being costed.
  async function learnMaterial(jobTypeId, processId, item) {
    if (!jobTypeId || !processId) return;
    const key = materialKey(jobTypeId, processId);
    const current = allowedMaterials[key];
    if (Array.isArray(current) && current.some((m) => m.inventory_id === item.id)) return;
    try {
      const { data } = await api.post(`/job-types/${jobTypeId}/process-materials/${processId}`, { inventory_id: item.id });
      if (!data) return;
      setAllowedMaterials((prev) => {
        const list = Array.isArray(prev[key]) ? prev[key] : [];
        return { ...prev, [key]: [...list, data] };
      });
    } catch {
      // ignored on purpose -- see above
    }
  }

  // The counterpart to learnMaterial: take a material back off the pair's defined list. Unlike
  // learning, this one reports failure -- learning silently is fine because the estimate keeps
  // the material either way, but a remove that quietly did nothing would have the user clicking
  // it again and again at a row that never goes.
  async function unlearnMaterial(jobTypeId, processId, item) {
    if (!jobTypeId || !processId) return;
    const key = materialKey(jobTypeId, processId);
    try {
      await api.delete(`/job-types/${jobTypeId}/process-materials/${processId}/${item.id}`);
      setAllowedMaterials((prev) => {
        const list = Array.isArray(prev[key]) ? prev[key] : [];
        const next = list.filter((m) => m.inventory_id !== item.id);
        // Emptying the list means nobody restricts this pair any more, which is what null means
        // here -- otherwise the picker would offer an empty list and no way to pick anything.
        return { ...prev, [key]: next.length ? next : null };
      });
    } catch (err) {
      alert(err.response?.data?.error || 'Could not remove that material from this job type.');
    }
  }

  // Fetched lazily: the pair is only known once both the Job Type and the Process are set,
  // and pre-loading every pair on an estimate with many job orders would be a lot of requests
  // for lists most of them never open.
  async function ensureAllowedMaterials(jobTypeId, processId) {
    if (!jobTypeId || !processId) return;
    const key = materialKey(jobTypeId, processId);
    if (key in allowedMaterials) return;
    try {
      const { data } = await api.get(`/job-types/${jobTypeId}/process-materials/${processId}`);
      // null = nobody restricted this pair, so the full inventory stays available.
      setAllowedMaterials((prev) => ({ ...prev, [key]: data.length ? data : null }));
    } catch {
      setAllowedMaterials((prev) => ({ ...prev, [key]: null }));
    }
  }

  function processCell(col, row, joIdx, procIdx) {
    const val = row[col.key] ?? '';
    if (col.type === 'picker-process') {
      return (
        <EntityPicker
          label="Process" items={processesList} value={val} getLabel={(p) => p.process_name}
          isSelectable={(p) => !!p.is_active}
          columns={[{ key: 'process_name', label: 'Process Name' }, { key: 'process_code', label: 'Code' }, { key: 'base_unit', label: 'Base Unit', render: (p) => unitLabel(p.base_unit_id) }]}
          searchKeys={['process_name', 'process_code']}
          onSelect={(p) => {
            ensureAllowedMaterials(jobOrders[joIdx]?.job_type_id, p.id);
            recalcAndCommitProcess(joIdx, procIdx, {
              process_id: p.id, process_uom: unitLabel(p.base_unit_id),
              ...(p.default_location_id ? { location_id: p.default_location_id } : {}),
            });
          }}
        />
      );
    }
    if (col.type === 'picker-proc-location') {
      return (
        <EntityPicker
          label="Process Location" items={locations} value={val} getLabel={(l) => l.location_name}
          columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
          searchKeys={['location_name', 'location_code']}
          onSelect={(l) => { setError(''); commitProcessRow(joIdx, procIdx, { location_id: l.id }); }}
        />
      );
    }
    if (col.type === 'picker-item') {
      const jobTypeId = jobOrders[joIdx]?.job_type_id;
      // Undefined = not fetched yet, null = unrestricted, array = the allowed list. Only the
      // array narrows the picker, so a pair nobody has configured still offers everything
      // rather than silently becoming unusable.
      const allowed = allowedMaterials[materialKey(jobTypeId, row.process_id)];
      const allowedIds = Array.isArray(allowed) ? new Set(allowed.map((m) => m.inventory_id)) : null;
      const restricted = !!allowedIds && !showAllMaterials;
      const items = restricted ? inventoryItems.filter((i) => allowedIds.has(i.id)) : inventoryItems;
      return (
        <EntityPicker
          label={restricted ? 'Material (restricted to this job type)' : 'Material'}
          headerExtra={(
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={showAllMaterials}
                onChange={(e) => setShowAllMaterials(e.target.checked)}
              />
              Show all materials
            </label>
          )}
          items={items} value={val} getLabel={(i) => i.display_name}
          columns={[
            { key: 'item_code', label: 'Code' },
            { key: 'display_name', label: 'Name' },
            { key: 'category_name', label: 'Category' },
            // Only on the restricted list: with "Show all materials" ticked the rows are the
            // whole catalogue, and most of them were never on this pair to remove.
            ...(restricted ? [{
              key: '_unlearn',
              label: '',
              render: (i) => (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  title={`Remove ${i.display_name} from this job type's process`}
                  // The row itself selects the material; without this, removing one would also
                  // pick it on the way out.
                  onClick={(e) => { e.stopPropagation(); unlearnMaterial(jobTypeId, row.process_id, i); }}
                >
                  ✕
                </button>
              ),
            }] : []),
          ]}
          searchKeys={['item_code', 'display_name']}
          onSelect={async (i) => {
            const itemUoms = await ensureUomsLoaded(i.id);
            // Starts on the item's base unit only if that is one of its assigned units (else the first).
            const base = String(i.base_unit_code || '').toUpperCase();
            const uom = (itemUoms.find((u) => String(u.code).toUpperCase() === base) || itemUoms[0] || {}).code || '';
            recalcAndCommitProcess(joIdx, procIdx, {
              item_id: i.id, unit: unitLabel(i.base_unit_id), uom,
            });
            // Chosen from outside the defined list -- remember it for next time.
            if (!allowedIds || !allowedIds.has(i.id)) learnMaterial(jobTypeId, row.process_id, i);
          }}
          // The material is the one picker on this row that may legitimately be empty -- a
          // labour-only process line carries none -- so a wrong choice has to be undoable
          // without deleting and re-adding the whole process row.
          //
          // Undoes exactly what onSelect above sets. The unit and UOM came from the material, so
          // leaving them behind would describe a material that is no longer there; the pricing
          // recalc already treats a line with no item_id as carrying no material cost.
          onClear={() => recalcAndCommitProcess(joIdx, procIdx, { item_id: null, unit: '', uom: '' })}
        />
      );
    }
    if (col.type === 'select-uom') {
      // Only the item's own units (components/ItemUomSelect.jsx) -- a unit outside them is not offered.
      return (
        <ItemUomSelect
          itemId={row.item_id} value={val} options={row.item_id ? uomsByItem[row.item_id] : undefined}
          onChange={(uom) => recalcAndCommitProcess(joIdx, procIdx, { uom })}
        />
      );
    }
    if (col.readOnly) {
      return <input value={val} readOnly tabIndex={-1} />;
    }
    // Length / Width only mean something for an item priced by size (Inventory > Priced by Length /
    // by Width; see computeAutoPricing's sizeFactor). For a "no conversion" item the price ignores
    // them, so typing one in looked like it changed something and did not (asked 2026-10-03).
    // Disabled rather than cleared, so a value already on the line stays visible.
    if (col.key === 'length' || col.key === 'width') {
      const item = row.item_id ? inventoryItems.find((i) => i.id === Number(row.item_id)) : null;
      const usable = !item || (col.key === 'length' ? !!item.is_length_based : !!(item.is_length_based && item.is_width_based));
      if (!usable) {
        return (
          <input value={val} disabled tabIndex={-1}
            title={col.key === 'length' ? 'This item is not priced by length' : 'This item is not priced by width'} />
        );
      }
    }
    const isPricingInput = col.key === 'qty' || col.key === 'length' || col.key === 'width'
      || col.key === 'process_qty' || col.key === 'process_disc_amount' || col.key === 'material_disc_amount'
      || col.key === 'process_disc_percent' || col.key === 'material_disc_percent';
    return (
      <input
        type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : col.type === 'time' ? 'time' : 'text'}
        step={col.type === 'number' ? '0.0001' : undefined}
        value={val}
        onChange={(e) => updateProcessField(joIdx, procIdx, col.key, e.target.value)}
        onBlur={() => (isPricingInput ? recalcAndCommitProcess(joIdx, procIdx, {}, col.key) : commitProcessRow(joIdx, procIdx))}
      />
    );
  }

  const employeeLabel = (e) => `${e.first_name} ${e.last_name}`;
  const employeeColumns = [
    { key: 'name', label: 'Name', render: employeeLabel },
    { key: 'position_title', label: 'Position' },
  ];

  if (loading) return <LoadingSpinner />;
  if (loadError) {
    return (
      <div className="card" style={{ margin: 24, padding: 24 }}>
        <h3 style={{ marginTop: 0 }}>This estimate could not be opened</h3>
        <p style={{ color: 'var(--danger, #c0392b)', wordBreak: 'break-word' }}>{loadError}</p>
        <button type="button" className="btn" onClick={init}>Try again</button>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>ESTIMATE — {isNew && !estimateId ? 'Create' : estimateNo}</h1>
        <Link className="btn" to={'/estimates'}>Back to Lists</Link>
      </div>

      <div className="card">
        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              <button
                type="button"
                className={`wizard-step ${step === i + 1 ? 'active' : ''}`}
                disabled={i + 1 > 1 && !estimateId}
                onClick={() => setStep(i + 1)}
              >
                <span className="num">{i + 1}</span> {label}
              </button>
              {i < STEPS.length - 1 && <span className="wizard-step-line" />}
            </Fragment>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {step === 1 && (
          <form onSubmit={goNextFromStep1}>
            <div className="wizard-cols">
              <div className="wizard-col">
                <div className="field">
                  <label>Date Created</label>
                  <input required type="date" value={header.date_created} onChange={(e) => setHeaderField('date_created', e.target.value)} />
                </div>
                <div className="field">
                  <label>Customer</label>
                  <EntityPicker
                    required label="Customer" items={customers} value={header.customer_id} getLabel={(c) => c.name}
                    columns={[{ key: 'name', label: 'Name' }, { key: 'company_name', label: 'Company' }, { key: 'list_address', label: 'Address', render: (c) => c.list_address || c.address || '' }]}
                    searchKeys={['name', 'company_name', 'customer_code', 'list_address']}
                    onSelect={handleCustomerSelect}
                  />
                </div>
                <div className="field">
                  <label>Contact Name</label>
                  <EntityPicker
                    label="Contact Name" items={contacts} value={header.contact_person_id} getLabel={(c) => c.contact_name}
                    columns={[{ key: 'contact_name', label: 'Name' }, { key: 'title', label: 'Title' }, { key: 'email', label: 'Email' }]}
                    searchKeys={['contact_name', 'email']}
                    onSelect={handleContactSelect}
                    disabled={!header.customer_id}
                    placeholder={header.customer_id ? 'Select contact...' : 'Select a customer first'}
                  />
                  {header.customer_id && !newContact && (
                    <button type="button" className="btn btn-link" style={{ padding: '4px 0' }}
                      onClick={() => { setContactError(''); setNewContact({ contact_name: '', title: '', email: '', phone: '' }); }}>
                      + Add new contact
                    </button>
                  )}
                  {newContact && (
                    <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 6, padding: 10, marginTop: 6 }}>
                      <label>New Contact <span className="muted">(saved to this customer in Master Lists)</span></label>
                      {contactError && <div className="error-banner">{contactError}</div>}
                      {[['contact_name', 'Name *'], ['title', 'Title'], ['email', 'Email'], ['phone', 'Contact No']].map(([key, label]) => (
                        <input key={key} placeholder={label} value={newContact[key]} style={{ marginBottom: 6 }}
                          onChange={(e) => setNewContact((current) => ({ ...current, [key]: e.target.value }))} />
                      ))}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="btn btn-primary" disabled={savingContact} onClick={saveNewContact}>
                          {savingContact ? 'Saving...' : 'Save Contact'}
                        </button>
                        <button type="button" className="btn" disabled={savingContact} onClick={() => setNewContact(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="field"><label>Contact Email</label><input value={header.contact_email} onChange={(e) => setHeaderField('contact_email', e.target.value)} /></div>
                <div className="field"><label>Contact Title</label><input value={header.contact_title} onChange={(e) => setHeaderField('contact_title', e.target.value)} /></div>
                <div className="field"><label>Contact Phone</label><input value={header.contact_phone} onChange={(e) => setHeaderField('contact_phone', e.target.value)} /></div>
                <div className="field">
                  <label>Blanket PO</label>
                  <EntityPicker
                    label="Blanket PO" items={blanketPos} value={header.blanket_po_id} getLabel={(p) => p.po_number}
                    columns={[{ key: 'po_number', label: 'PO Number' }, { key: 'memo', label: 'Memo' }]}
                    searchKeys={['po_number']}
                    onSelect={(p) => setHeaderField('blanket_po_id', p.id)}
                    disabled={!header.customer_id}
                    placeholder={header.customer_id ? 'Select PO...' : 'Select a customer first'}
                  />
                  {header.customer_id && (
                    <div className="inline-form" style={{ marginTop: 6 }}>
                      <div className="field"><input placeholder="New PO number" value={newPo} onChange={(e) => setNewPo(e.target.value)} /></div>
                      <button type="button" className="btn btn-sm" onClick={addBlanketPo}>Add</button>
                    </div>
                  )}
                </div>
                <div className="field"><label>Blanket PO Memo</label><input value={header.blanket_po_memo} onChange={(e) => setHeaderField('blanket_po_memo', e.target.value)} /></div>
              </div>

              <div className="wizard-col">
                <div className="field">
                  <label>Sales Rep.</label>
                  <EntityPicker
                    label="Sales Rep" items={employees} value={header.sales_rep_id} getLabel={employeeLabel}
                    // Active employees only -- an inactive duplicate record (no login) hid a rep's
                    // estimates from her own account. The rep already on the estimate still shows.
                    isSelectable={(e) => !!Number(e.is_active)}
                    columns={employeeColumns} searchKeys={['first_name', 'last_name', 'employee_code']}
                    onSelect={(e) => setHeaderField('sales_rep_id', e.id)}
                  />
                </div>
                <div className="field">
                  <label>Sales Division *</label>
                  <EntityPicker
                    label="Sales Division" items={salesDivisions} value={header.sales_division_id} getLabel={(s) => s.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                    onSelect={(s) => setHeaderField('sales_division_id', s.id)}
                  />
                </div>
                <div className="field">
                  <label>Office Location</label>
                  <EntityPicker
                    label="Office Location" items={locations} value={header.office_location_id} getLabel={(l) => l.location_name}
                    columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
                    searchKeys={['location_name', 'location_code']}
                    onSelect={(l) => setHeaderField('office_location_id', l.id)}
                  />
                </div>
                <div className="field">
                  <label>Contract Description</label>
                  <textarea required rows={2} value={header.contract_description} onChange={(e) => setHeaderField('contract_description', e.target.value)} />
                </div>
                <div className="field">
                  <label>Memo</label>
                  <textarea rows={2} value={header.memo} onChange={(e) => setHeaderField('memo', e.target.value)} />
                </div>
                <div className="field"><label>Shipping Address</label><input value={header.shipping_address} onChange={(e) => setHeaderField('shipping_address', e.target.value)} /></div>
                <div className="field-checkbox">
                  <input type="checkbox" id="multi-ship" checked={header.has_multiple_shipping} onChange={(e) => setHeaderField('has_multiple_shipping', e.target.checked)} />
                  <label htmlFor="multi-ship">Multiple Shipping Address</label>
                </div>
              </div>

              <div className="wizard-col">
                <div className="field"><label>Production Lead Time</label><input required value={header.production_lead_time} onChange={(e) => setHeaderField('production_lead_time', e.target.value)} placeholder="e.g. 5 working days" /></div>
                <div className="field"><label>Price Validity</label><input value={header.price_validity} onChange={(e) => setHeaderField('price_validity', e.target.value)} placeholder="e.g. 30 days" /></div>
                <div className="field">
                  <label>Order Confirmation</label>
                  <select
                    value={header.order_confirmation_type}
                    onChange={(e) => {
                      setHeaderField('order_confirmation_type', e.target.value);
                      // Clearing the type clears the reference with it -- a PO number left
                      // behind under "Conforme" is worse than an empty field.
                      if (!e.target.value) setHeaderField('order_confirmation_ref', '');
                    }}
                  >
                    <option value="">—</option>
                    {ORDER_CONFIRMATION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>

                {/* The number behind the confirmation, revealed only once a type is chosen.
                    Recording that a PO exists without recording which one is what this
                    replaces. Optional: the type is often known before the paperwork lands. */}
                {header.order_confirmation_type && (
                  <div className="field">
                    <label>{ORDER_CONFIRMATION_REF_LABEL[header.order_confirmation_type] || 'Reference No.'}</label>
                    <input
                      value={header.order_confirmation_ref}
                      onChange={(e) => setHeaderField('order_confirmation_ref', e.target.value)}
                      placeholder={ORDER_CONFIRMATION_REF_PLACEHOLDER[header.order_confirmation_type] || ''}
                    />
                  </div>
                )}

                {/* Supporting documents. Deliberately not gated on a confirmation type being
                    chosen -- a scan can arrive before anyone records what kind it is. */}
                <div className="field">
                  <label>Attachments <span className="muted">(optional — PDF or image, up to 10MB each)</span></label>
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    multiple
                    onChange={(e) => addPendingAttachments(e.target.files)}
                  />
                  {attachmentError && <div className="error" style={{ marginTop: 4 }}>{attachmentError}</div>}
                  {pendingAttachments.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="field-checkbox" style={{ justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.85em' }}>
                        {f.name} <span className="muted">({(f.size / 1024).toFixed(0)} KB)</span>
                      </span>
                      <button type="button" className="btn btn-sm"
                        onClick={() => setPendingAttachments((prev) => prev.filter((_, x) => x !== i))}>Remove</button>
                    </div>
                  ))}
                </div>
                <div className="field">
                  <div className="field-checkbox">
                    <input type="checkbox" id="print-w" checked={header.print_warranty} onChange={(e) => setHeaderField('print_warranty', e.target.checked)} />
                    <label htmlFor="print-w">Print Warranty</label>
                  </div>
                  {header.print_warranty && <input placeholder="Term e.g. 6 Months" value={header.print_warranty_term} onChange={(e) => setHeaderField('print_warranty_term', e.target.value)} />}
                </div>
                <div className="field">
                  <div className="field-checkbox">
                    <input type="checkbox" id="struct-w" checked={header.structure_warranty} onChange={(e) => setHeaderField('structure_warranty', e.target.checked)} />
                    <label htmlFor="struct-w">Structure Warranty</label>
                  </div>
                  {header.structure_warranty && <input placeholder="Term e.g. 12 Months" value={header.structure_warranty_term} onChange={(e) => setHeaderField('structure_warranty_term', e.target.value)} />}
                </div>
                <div className="field">
                  <div className="field-checkbox">
                    <input type="checkbox" id="elec-w" checked={header.electrical_warranty} onChange={(e) => setHeaderField('electrical_warranty', e.target.checked)} />
                    <label htmlFor="elec-w">Electrical Warranty</label>
                  </div>
                  {header.electrical_warranty && <input placeholder="Term e.g. 3 Months" value={header.electrical_warranty_term} onChange={(e) => setHeaderField('electrical_warranty_term', e.target.value)} />}
                </div>
              </div>
            </div>

            <div className="wizard-actions">
              <span />
              <button type="submit" className="btn btn-primary">NEXT</button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div>
            <div className="field-row" style={{ maxWidth: 500, marginBottom: 16 }}>
              <div className="field">
                <label>Shipping Address</label>
                <input value={header.shipping_address} onChange={(e) => setHeaderField('shipping_address', e.target.value)} onBlur={saveHeader} />
              </div>
              <div className="field-checkbox" style={{ alignSelf: 'center', marginTop: 18 }}>
                <input type="checkbox" id="multi-ship-2" checked={header.has_multiple_shipping} onChange={(e) => { setHeaderField('has_multiple_shipping', e.target.checked); api.put(`/estimates/${estimateId}`, { ...buildHeaderPayload(), has_multiple_shipping: e.target.checked }); }} />
                <label htmlFor="multi-ship-2">Multiple Shipping Address</label>
              </div>
            </div>
            {header.has_multiple_shipping && (
              <div className="subsection" style={{ marginTop: 0 }}>
                <DataTable
                  columns={[{ key: 'address', label: 'Address' }]}
                  rows={shippingAddresses}
                  actions={(a) => <button className="btn btn-sm btn-danger" onClick={() => removeShipping(a.id)}>Remove</button>}
                  emptyLabel="No additional shipping addresses yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field"><input placeholder="New address" value={newShipping} onChange={(e) => setNewShipping(e.target.value)} /></div>
                  <button type="button" className="btn btn-sm" onClick={addShipping}>Add</button>
                </div>
              </div>
            )}

            <div className="spreadsheet-wrap">
              <table className="spreadsheet-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {/* The required ones are marked in the header, so the asterisk is visible
                        while the grid is being filled rather than only in the error at NEXT. */}
                    {JOB_ORDER_COLUMNS.map((c) => (
                      <th key={c.key}>
                        {c.label}
                        {['delivery_date', 'delivery_time', 'tax_code_id'].includes(c.key) && <span style={{ color: '#b91c1c' }}> *</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                {jobOrders.map((jo, idx) => {
                  const missing = !jo.job_type_id || !jo.quantity || !jo.units;
                  return (
                    <tbody key={jo.id || jo._tempId}>
                      <tr className={!jo.id ? 'draft-row' : ''}>
                        <td>
                          <div className="spreadsheet-row-actions">
                            <button type="button" className="btn btn-sm" title={hasDraftLine ? 'Finish the unsaved line first' : 'Move this line up'}
                              disabled={idx === 0 || hasDraftLine || reordering} onClick={() => moveJobOrderRow(idx, -1)}>▲</button>
                            <button type="button" className="btn btn-sm" title={hasDraftLine ? 'Finish the unsaved line first' : 'Move this line down'}
                              disabled={idx === jobOrders.length - 1 || hasDraftLine || reordering} onClick={() => moveJobOrderRow(idx, 1)}>▼</button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteJobOrderRow(idx)}>✕</button>
                            <button type="button" className="btn btn-sm" title="Copy this line, with its processes, as a new line"
                              disabled={copyingJo !== null} onClick={() => duplicateJobOrderRow(idx)}>{copyingJo === idx ? '…' : 'Copy'}</button>
                          </div>
                        </td>
                        {JOB_ORDER_COLUMNS.map((col) => <td key={col.key}>{jobOrderCell(col, jo, idx)}</td>)}
                      </tr>
                      <tr>
                        <td colSpan={JOB_ORDER_COLUMNS.length + 1} style={{ background: 'var(--bg)' }}>
                          {/* What this job has gone for before, from 126k priced history lines.
                              OUTSIDE the saved/unsaved branch on purpose: a line is only saved
                              once Job Type, Quantity and Units are filled, and by then the rep
                              has already decided the price. This has to be readable while they
                              are still typing the description, which is the only moment it can
                              change what they do. */}
                          <div style={{ padding: '0 8px' }}>
                            <RepeatWorkPanel
                              lineNo={jo.line_no || idx + 1}
                              description={jo.description}
                              jobTypeId={jo.job_type_id}
                              quantity={jo.quantity}
                              units={jo.units}
                            />
                          </div>
                          {!jo.id ? (
                            <p className="muted" style={{ margin: 8 }}>
                              {missing ? 'Fill Job Type, Quantity, and Units to save this line before adding processes.' : 'Saving…'}
                            </p>
                          ) : (
                            <div style={{ padding: 8 }}>
                              <div className="spreadsheet-wrap">
                                <table className="spreadsheet-table">
                                  <thead>
                                    <tr>
                                      <th>#</th>
                                      {PROCESS_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(jo.processes || []).map((proc, procIdx) => (
                                      <tr key={proc.id || proc._tempId} className={`process-row ${!proc.id ? 'draft-row' : ''}`}>
                                        <td>
                                          <div className="spreadsheet-row-actions">
                                            <button type="button" className="btn btn-sm" title={hasDraftLine ? 'Finish the unsaved line first' : 'Move this process up'}
                                              disabled={procIdx === 0 || hasDraftLine || reordering} onClick={() => moveProcessRow(idx, procIdx, -1)}>▲</button>
                                            <button type="button" className="btn btn-sm" title={hasDraftLine ? 'Finish the unsaved line first' : 'Move this process down'}
                                              disabled={procIdx === jo.processes.length - 1 || hasDraftLine || reordering} onClick={() => moveProcessRow(idx, procIdx, 1)}>▼</button>
                                            <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteProcessRow(idx, procIdx)}>✕</button>
                                          </div>
                                        </td>
                                        {PROCESS_COLUMNS.map((col) => <td key={col.key}>{processCell(col, proc, idx, procIdx)}</td>)}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {/* Contingency and the resulting Total, under the process list where
                                  the real system puts them. Typing in either box fills the other:
                                  a percentage of the process base, or an amount that reveals what
                                  percentage it is. */}
                              <div className="contingency-box">
                                <div className="contingency-row">
                                  <span className="contingency-label">Contingency</span>
                                  <span className="muted">%</span>
                                  <input
                                    type="number" step="0.000001" min="0"
                                    defaultValue={jo.contingency_percent ?? ''}
                                    key={`cp-${jo.id}-${jo.contingency_percent ?? ''}`}
                                    onBlur={(e) => commitContingency(idx, 'contingency_percent', e.target.value)}
                                  />
                                </div>
                                <div className="contingency-row">
                                  <span className="contingency-label" />
                                  <span className="muted">Amount</span>
                                  <input
                                    type="number" step="0.01" min="0"
                                    defaultValue={jo.contingency_amount ?? ''}
                                    key={`ca-${jo.id}-${jo.contingency_amount ?? ''}`}
                                    onBlur={(e) => commitContingency(idx, 'contingency_amount', e.target.value)}
                                  />
                                </div>
                                <div className="contingency-row contingency-total">
                                  <span className="contingency-label">Total</span>
                                  <span />
                                  <strong>{money(jo.subtotal)}</strong>
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <button type="button" className="btn btn-sm btn-primary" disabled={!jo.job_type_id} onClick={() => openProcessPicker(idx, jo.job_type_id)}>
                                  Choose Processes
                                </button>
                                <button type="button" className="btn btn-sm" onClick={() => addProcessRow(idx)}>Add Process</button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  );
                })}
              </table>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={addJobOrderRow}>Add Job</button>

            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(1)}>PREVIOUS</button>
              {/* Delivery Date and Time are what the customer is being promised and are required
                  on every job line. The server refuses to approve an estimate without them, so
                  this is the message rather than the enforcement -- said here, where the lines
                  are, instead of three steps later when someone tries to approve. */}
              <button
                type="button" className="btn btn-primary"
                onClick={() => {
                  const missing = jobOrders
                    .map((jo, i) => ({ n: i + 1, noDate: !jo.delivery_date, noTime: !jo.delivery_time }))
                    .filter((x) => x.noDate || x.noTime);
                  if (missing.length) {
                    const detail = missing.slice(0, 5)
                      .map((x) => `line ${x.n} (no delivery ${x.noDate && x.noTime ? 'date and time' : (x.noDate ? 'date' : 'time')})`)
                      .join(', ');
                    setError(`Delivery Date and Delivery Time are required on every job line: ${detail}${missing.length > 5 ? `, and ${missing.length - 5} more` : ''}.`);
                    return;
                  }
                  // A replica's lines need their new Job Location too -- the old job's was not copied.
                  if (isReplica) {
                    const noLoc = jobOrders.map((jo, i) => (jo.job_location_id ? null : i + 1)).filter(Boolean);
                    if (noLoc.length) {
                      setError(`This estimate is a replica -- put the new Job Location on every job line: line ${noLoc.slice(0, 8).join(', ')}${noLoc.length > 8 ? ` and ${noLoc.length - 8} more` : ''}.`);
                      return;
                    }
                  }
                  // Tax Code is required on every job line too (asked 2026-10-20) -- the server
                  // refuses to approve without it.
                  const noTax = jobOrders.map((jo, i) => (jo.tax_code_id ? null : i + 1)).filter(Boolean);
                  if (noTax.length) {
                    setError(`Tax Code is required on every job line: line ${noTax.slice(0, 8).join(', ')}${noTax.length > 8 ? ` and ${noTax.length - 8} more` : ''}.`);
                    return;
                  }
                  const qtyGaps = jobOrders.map((jo, i) => {
                    const g = processQtyGaps(jo);
                    return g.length ? `line ${i + 1} ${g.join(', ')}` : null;
                  }).filter(Boolean);
                  if (qtyGaps.length) {
                    setError(`Process Qty and Material Qty are required: ${qtyGaps.slice(0, 5).join('; ')}${qtyGaps.length > 5 ? `; and ${qtyGaps.length - 5} more line(s)` : ''}.`);
                    return;
                  }
                  saveHeaderAndGoTo(3);
                }}
              >
                NEXT
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="wizard-cols">
              <div className="wizard-col">
                <div className="field">
                  <label>Credit Term *</label>
                  <EntityPicker
                    required label="Credit Term" items={paymentTerms}
                    value={paymentTerms.find((t) => t.term_name === header.credit_term)?.id ?? ''}
                    getLabel={(t) => t.term_name}
                    columns={[{ key: 'term_name', label: 'Term' }, { key: 'no_of_days', label: 'No. of Days' }]}
                    searchKeys={['term_name']}
                    onSelect={(t) => setHeaderField('credit_term', t.term_name)}
                  />
                </div>
                <div className="field"><label>Credit Limit</label><input type="number" step="0.01" value={header.credit_limit} onChange={(e) => setHeaderField('credit_limit', e.target.value)} /></div>
                <div className="field"><label>Credit Balance</label><input type="number" step="0.01" value={header.credit_balance} onChange={(e) => setHeaderField('credit_balance', e.target.value)} /></div>
                <div className="field"><label>Bill-To Contact #</label><input value={header.bill_to_contact_number} onChange={(e) => setHeaderField('bill_to_contact_number', e.target.value)} /></div>
              </div>
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(2)}>PREVIOUS</button>
              {/* Credit Term is required, and this is where it is asked. The step is a set of
                  buttons rather than a form, so the picker's own `required` never fires a
                  browser validation -- the check has to be made here. The server refuses an
                  estimate moving forward without one too, so this is the message rather than
                  the enforcement. */}
              <button
                type="button" className="btn btn-primary"
                onClick={() => {
                  if (!header.credit_term) {
                    setError('Credit Term is required. Pick the payment term agreed with the customer.');
                    return;
                  }
                  saveHeaderAndGoTo(4);
                }}
              >
                NEXT
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3>Summary</h3>
            <div className="review-grid">
              <div className="item"><div className="label">Estimate No.</div><div className="value">{estimateNo}</div></div>
              <div className="item"><div className="label">Customer</div><div className="value">{customers.find((c) => c.id === header.customer_id)?.name || '—'}</div></div>
              <div className="item"><div className="label">Status</div><div className="value">{header.status.replaceAll('_', ' ')}</div></div>
              <div className="item"><div className="label">Total Amount</div><div className="value">{jobOrders.reduce((s, jo) => s + (Number(jo.gross_amount) || 0), 0).toFixed(2)}</div></div>
              <div className="item"><div className="label">Sales Rep</div><div className="value">{employees.find((e) => e.id === header.sales_rep_id) ? employeeLabel(employees.find((e) => e.id === header.sales_rep_id)) : '—'}</div></div>
              <div className="item"><div className="label">Production Lead Time</div><div className="value">{header.production_lead_time || '—'}</div></div>
            </div>

            <h3 className="subsection">Job Orders</h3>
            <DataTable
              columns={[
                { key: 'line_no', label: '#' },
                { key: 'description', label: 'Description' },
                { key: 'quantity', label: 'Qty' },
                { key: 'units', label: 'Units' },
                { key: 'gross_amount', label: 'Gross' },
              ]}
              rows={jobOrders.filter((jo) => jo.id)}
              emptyLabel="No job order lines."
            />

            <h3 className="subsection">Shipping Addresses</h3>
            <DataTable columns={[{ key: 'address', label: 'Address' }]} rows={shippingAddresses} emptyLabel="None." />

            <h3 className="subsection">Audit Trail</h3>
            <DataTable
              columns={[
                { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
                { key: 'set_by_name', label: 'Set By' },
                { key: 'event_type', label: 'Type' },
                { key: 'field_name', label: 'Field' },
                { key: 'old_value', label: 'Old Value' },
                { key: 'new_value', label: 'New Value' },
              ]}
              rows={auditLogs}
              emptyLabel="No audit history yet."
            />

            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(3)}>PREVIOUS</button>
              <Link className="btn btn-primary" to={'/estimates'}>Back to Lists</Link>
            </div>
          </div>
        )}
      </div>

      {/* The estimate's overall totals, live as lines are added and edited (asked 2026-10-03) --
          the same figures and the same arithmetic as the View page's footer (EstimateView.jsx):
          GP is the sum of the lines' own GP, Total Cost what that leaves of Net of Tax. */}
      {(() => {
        const n = (v) => Number(v) || 0;
        const lineCost = (jo) => (jo.processes || []).reduce((s, p) => s + n(p.total_cost), 0);
        const lineGp = (jo) => (jo.gp_amount != null && jo.gp_amount !== '' ? n(jo.gp_amount) : n(jo.subtotal) - n(jo.disc_amount) - lineCost(jo));
        const discount = jobOrders.reduce((s, jo) => s + n(jo.disc_amount), 0);
        const net = jobOrders.reduce((s, jo) => s + n(jo.subtotal), 0) - discount;
        const tax = jobOrders.reduce((s, jo) => s + n(jo.tax_amount), 0);
        const gp = jobOrders.reduce((s, jo) => s + lineGp(jo), 0);
        return (
          <div className="estimate-footer card" style={{ marginTop: 16 }}>
            <div><span className="muted">Est. GP Rate</span><div className="hi-lg">{(net ? (gp / net) * 100 : 0).toFixed(2)}%</div></div>
            <div><span className="muted">Est. GP Amount</span><div className="hi-lg">{money(gp)}</div></div>
            <div><span className="muted">Total Cost</span><div className="hi-lg">{money(net - gp)}</div></div>
            <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(net)}</div></div>
            <div><span className="muted">Discount</span><div className="hi-lg">{money(discount)}</div></div>
            <div><span className="muted">Tax</span><div className="hi-lg">{money(tax)}</div></div>
            <div><span className="muted">Total Amount</span><div className="hi-lg">{money(net + tax)}</div></div>
          </div>
        );
      })()}

      {processPicker && (
        <Modal title="Processes for this Job Type" onClose={() => setProcessPicker(null)} large>
          {processPicker.loading ? <LoadingSpinner /> : (
            <>
              {processPicker.rows.length === 0 ? (
                <div className="empty-state">
                  This job type has no processes defined. Add them on the Job Type screen, or use
                  Add Process to enter one by hand.
                </div>
              ) : (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Tick the processes this job actually needs. Only this job type's {processPicker.rows.length} processes are listed.
                  </p>
                  <input
                    autoFocus
                    style={{ width: '100%', marginBottom: 10 }}
                    placeholder="Search by code or name..."
                    value={processPicker.search}
                    onChange={(e) => setProcessPicker((prev) => (prev ? { ...prev, search: e.target.value } : prev))}
                  />
                  <div className="table-wrap" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 36 }}></th>
                          <th>Process Code</th>
                          <th>Process Name</th>
                          <th>Time Study (min)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processPicker.rows.filter((r) => {
                          const q = processPicker.search.trim().toLowerCase();
                          if (!q) return true;
                          return `${r.process_code} ${r.process_name}`.toLowerCase().includes(q);
                        }).map((r) => {
                          const checked = processPicker.selected.has(r.process_id);
                          const toggle = () => setProcessPicker((prev) => {
                            if (!prev) return prev;
                            const selected = new Set(prev.selected);
                            if (selected.has(r.process_id)) selected.delete(r.process_id); else selected.add(r.process_id);
                            return { ...prev, selected };
                          });
                          return (
                            <tr key={r.id} onClick={toggle} style={{ cursor: 'pointer' }}>
                              <td><input type="checkbox" checked={checked} onChange={toggle} onClick={(e) => e.stopPropagation()} /></td>
                              <td>{r.process_code}</td>
                              <td>{r.process_name}</td>
                              <td>{r.effective_minutes_per_unit ?? ''}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="wizard-actions" style={{ marginTop: 12 }}>
                <button type="button" className="btn" onClick={() => setProcessPicker(null)}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={processPicker.selected.size === 0} onClick={confirmProcessPicker}>
                  Add Selected ({processPicker.selected.size})
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
