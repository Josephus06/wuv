// Unit conversions, answered in code rather than by the chatbot's model.
//
// WHY THIS IS DETERMINISTIC. The system prompt in sqlFallback.js invites the model to
// answer arithmetic and unit conversions itself, and gpt-4o-mini got them wrong in a
// specific, repeatable way: asked to "convert 3x4 meter to sqft" it answered 32.29 --
// that is 3 x 10.7639, one dimension converted and the other silently dropped. Pushed on
// it ("are you sure?") it then worked the same question out properly to 129.17 while
// opening with "Yes, I'm sure!", so the wrong answer never got retracted. temperature 0
// makes that repeatable rather than rare.
//
// The damage isn't the arithmetic on its own -- it's that 129.1669 is exactly what the
// estimate form computes for a 3x4 MTR line, so the assistant was contradicting the
// application it sits inside, and the person reading it has no way to tell which is
// right. Moving to a stronger model narrows that but doesn't close it; arithmetic a
// computer can do exactly should not be guessed at by a language model at all.
//
// The factors come from shared/costing.js -- the same LENGTH_UNIT_TO_FEET /
// AREA_UNIT_TO_SQFT tables and the same convertAreaToBaseUnit/convertLengthToBaseUnit the
// costing engine prices with -- so a conversion quoted here and a Total computed on a
// process line cannot disagree. A second table here would have been free to drift.
//
// Anything this cannot confidently parse returns null and falls through to the model
// untouched, so this only ever narrows what the model is asked to do.
const { costing } = require('./costing');

// Unit words people actually type, mapped onto the codes those shared tables key on.
// Longest match wins (see resolveUnit), so "linear meter" is not read as "meter" and
// "square foot" is not read as "foot".
const LINEAR_WORDS = {
  MM: ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'],
  CM: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'],
  MTR: ['m', 'mtr', 'meter', 'meters', 'metre', 'metres'],
  LMTR: ['lm', 'lmtr', 'linear meter', 'linear meters', 'linear metre', 'linear metres'],
  IN: ['in', 'inch', 'inches', '"'],
  LINCH: ['linch', 'linear inch', 'linear inches'],
  FT: ['ft', 'foot', 'feet', "'"],
  LFT: ['lft', 'linear foot', 'linear feet'],
  YD: ['yd', 'yard', 'yards'],
};
const AREA_WORDS = {
  SQFT: ['sqft', 'sq ft', 'sqf', 'sq feet', 'sq foot', 'square ft', 'square foot', 'square feet', 'ft2', 'ft²'],
  SQM: ['sqm', 'sq m', 'sq meter', 'sq meters', 'square m', 'square meter', 'square meters', 'square metre', 'square metres', 'm2', 'm²'],
};
// How each unit is written back in the reply -- the code for the ERP's own linear units
// (LINCH/LMTR/LFT mean something specific here and are worth echoing verbatim), a normal
// abbreviation for the rest.
const LABELS = { MM: 'mm', CM: 'cm', MTR: 'm', LMTR: 'LMTR', IN: 'in', LINCH: 'LINCH', FT: 'ft', LFT: 'LFT', YD: 'yd', SQFT: 'sq ft', SQM: 'sq m' };
// The area unit a length in this unit squares into, for phrasing the intermediate step.
const SQUARE_OF = { FT: 'SQFT', LFT: 'SQFT', MTR: 'SQM', M: 'SQM', LMTR: 'SQM' };

function resolveUnit(text, table) {
  const t = String(text || '').trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  let best = null;
  for (const [code, words] of Object.entries(table)) {
    for (const w of words) {
      if (t === w && (!best || w.length > best.word.length)) best = { code, word: w };
    }
  }
  return best ? best.code : null;
}

// 4 decimals is what the process-line Total column carries, so a conversion quoted in
// chat and the same figure read off a job order match digit for digit.
function fmt(n) {
  const rounded = Number(n.toFixed(4));
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// Splits "<something> to <unit>" / "how many <unit> is <something>" into the value side
// and the target unit. `in` is only accepted as a connector in the "how many X in Y"
// shape, because everywhere else it is far more likely to mean inches.
function splitRequest(message) {
  const text = String(message || '').trim().toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ');

  const howMany = text.match(/^(?:how many|how much|convert|what is|what's|whats)?\s*(?:how many|how much)?\s*([a-z0-9"'² ]+?)\s+(?:is|are|in|equals?|=)\s+(.+)$/);
  if (howMany && (resolveUnit(howMany[1], AREA_WORDS) || resolveUnit(howMany[1], LINEAR_WORDS))) {
    return { target: howMany[1], value: howMany[2] };
  }
  // "pila ka sqft ang 3x4 meter" -- the same question in Cebuano/Bisaya, which the system
  // prompt already promises to understand ("pila" = how many, "ang"/"sa" carrying the
  // "is/of"). Tagalog "ilan"/"ilang" takes the same shape.
  const bisaya = text.match(/^(?:pila|ilan|ilang)\s+(?:ka\s+)?([a-z0-9"'² ]+?)\s+(?:ang|sa|ay|na)\s+(.+)$/);
  if (bisaya && (resolveUnit(bisaya[1], AREA_WORDS) || resolveUnit(bisaya[1], LINEAR_WORDS))) {
    return { target: bisaya[1], value: bisaya[2] };
  }
  const toShape = text.match(/^(.+?)\s+(?:to|into|=)\s+([a-z0-9"'² ]+)$/);
  if (toShape) return { target: toShape[2], value: toShape[1] };
  return null;
}

// "convert 3x4 meter" -> { a: 3, b: 4, unit: 'meter' }; "19 inches" -> { a: 19, unit: 'inches' }
function parseValue(text) {
  const t = String(text).replace(/^(?:convert|what is|what's|whats|how many|how much)\s+/, '').trim();
  const area = t.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([a-z0-9"'² ]*)$/);
  if (area) return { a: Number(area[1]), b: Number(area[2]), unit: area[3] };
  const linear = t.match(/(\d+(?:\.\d+)?)\s*([a-z0-9"'² ]*)$/);
  if (linear) return { a: Number(linear[1]), b: null, unit: linear[2] };
  return null;
}

// Returns a finished reply string, or null to let the model handle the message.
async function answerUnitConversion(message) {
  const split = splitRequest(message);
  if (!split) return null;
  const parsed = parseValue(split.value);
  if (!parsed || !Number.isFinite(parsed.a) || (parsed.b !== null && !Number.isFinite(parsed.b))) return null;

  const fromLinear = resolveUnit(parsed.unit, LINEAR_WORDS);
  const fromArea = resolveUnit(parsed.unit, AREA_WORDS);
  const toLinear = resolveUnit(split.target, LINEAR_WORDS);
  const toArea = resolveUnit(split.target, AREA_WORDS);
  if (!fromLinear && !fromArea) return null;
  if (!toLinear && !toArea) return null;

  const { convertAreaToBaseUnit, convertLengthToBaseUnit, AREA_UNIT_TO_SQFT } = await costing();

  // Length x Width -> an area. The one the model kept getting wrong.
  if (parsed.b !== null && fromLinear && toArea) {
    const result = convertAreaToBaseUnit(parsed.a, parsed.b, fromLinear, toArea);
    const dims = `${fmt(parsed.a)} x ${fmt(parsed.b)} ${LABELS[fromLinear]}`;
    // When the entered unit squares straight into the target (2 x 2 ft -> sq ft) the
    // intermediate step IS the answer, so stating it twice just reads as padding.
    if (SQUARE_OF[fromLinear] === toArea) return `${dims} = ${fmt(result)} ${LABELS[toArea]}.`;
    const native = SQUARE_OF[fromLinear];
    const step = native ? `${fmt(parsed.a * parsed.b)} ${LABELS[native]}` : null;
    return step
      ? `${dims} = ${step}, which is ${fmt(result)} ${LABELS[toArea]}.`
      : `${dims} = ${fmt(result)} ${LABELS[toArea]}.`;
  }

  // A single length -> another length.
  if (parsed.b === null && fromLinear && toLinear) {
    const result = convertLengthToBaseUnit(parsed.a, fromLinear, toLinear);
    return `${fmt(parsed.a)} ${LABELS[fromLinear]} = ${fmt(result)} ${LABELS[toLinear]}.`;
  }

  // An area figure -> another area unit.
  if (parsed.b === null && fromArea && toArea) {
    const result = (parsed.a * AREA_UNIT_TO_SQFT[fromArea]) / AREA_UNIT_TO_SQFT[toArea];
    return `${fmt(parsed.a)} ${LABELS[fromArea]} = ${fmt(result)} ${LABELS[toArea]}.`;
  }

  // Everything else is a mismatch the arithmetic cannot fix -- a single length asked for
  // as an area ("3 m to sqft"), or an area asked for as a length. Say so plainly rather
  // than inventing a number, and rather than handing it to the model to invent one.
  if (parsed.b === null && fromLinear && toArea) {
    return `${fmt(parsed.a)} ${LABELS[fromLinear]} is a length, not an area -- I need both sides to give you ${LABELS[toArea]} (e.g. "${fmt(parsed.a)}x4 ${LABELS[fromLinear]} to ${LABELS[toArea]}").`;
  }
  return null;
}

module.exports = { answerUnitConversion };
