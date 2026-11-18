// The pricing formulas moved to shared/costing.js so the API can price customer quotes with the
// same code the estimate wizard uses, rather than a transcription of it. This re-export keeps
// every existing `import ... from '../utils/costing'` working unchanged.
export {
  convertAreaToBaseUnit,
  convertLengthToBaseUnit,
  selectBracket,
  computeProcessCosting,
  computeMaterialCosting,
  computeAutoPricing,
} from '../../../shared/costing.js';
