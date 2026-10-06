// Trades and towns: the one list the dashboard, the admin and the server all use.
// A slug is stored in the database, so never rename one; change only its label.

export const TRADES = [
  { slug: 'hidraulik', label: 'Hidraulik' },
  { slug: 'elektricist', label: 'Elektricist' },
  { slug: 'bojaxhi', label: 'Bojaxhi' },
  { slug: 'pllakaxhi', label: 'Pllakaxhi' },
  { slug: 'murator', label: 'Murator' },
  { slug: 'zdrukthetar', label: 'Zdrukthëtar' },
  { slug: 'ngrohje-klime', label: 'Ngrohje dhe klimë' },
  { slug: 'rigips', label: 'Rigips dhe suva' },
  { slug: 'fasade', label: 'Fasadë dhe izolim' },
  { slug: 'dysheme', label: 'Dysheme dhe parket' },
  { slug: 'dyer-dritare', label: 'Dyer dhe dritare' },
  { slug: 'kulmi', label: 'Kulm dhe çati' },
  { slug: 'saldim', label: 'Saldim dhe hekurishte' },
  { slug: 'riparime', label: 'Riparime të vogla' },
];

// The 38 municipalities of Kosovo, largest first.
export const TOWNS = [
  { slug: 'prishtine', label: 'Prishtinë' },
  { slug: 'prizren', label: 'Prizren' },
  { slug: 'ferizaj', label: 'Ferizaj' },
  { slug: 'peje', label: 'Pejë' },
  { slug: 'gjakove', label: 'Gjakovë' },
  { slug: 'gjilan', label: 'Gjilan' },
  { slug: 'podujeve', label: 'Podujevë' },
  { slug: 'mitrovice', label: 'Mitrovicë' },
  { slug: 'vushtrri', label: 'Vushtrri' },
  { slug: 'suhareke', label: 'Suharekë' },
  { slug: 'rahovec', label: 'Rahovec' },
  { slug: 'drenas', label: 'Drenas' },
  { slug: 'lipjan', label: 'Lipjan' },
  { slug: 'malisheve', label: 'Malishevë' },
  { slug: 'kamenice', label: 'Kamenicë' },
  { slug: 'viti', label: 'Viti' },
  { slug: 'decan', label: 'Deçan' },
  { slug: 'istog', label: 'Istog' },
  { slug: 'kline', label: 'Klinë' },
  { slug: 'skenderaj', label: 'Skënderaj' },
  { slug: 'dragash', label: 'Dragash' },
  { slug: 'fushe-kosove', label: 'Fushë Kosovë' },
  { slug: 'kacanik', label: 'Kaçanik' },
  { slug: 'shtime', label: 'Shtime' },
  { slug: 'obiliq', label: 'Obiliq' },
  { slug: 'leposaviq', label: 'Leposaviq' },
  { slug: 'gracanice', label: 'Graçanicë' },
  { slug: 'han-i-elezit', label: 'Han i Elezit' },
  { slug: 'zvecan', label: 'Zveçan' },
  { slug: 'shterpce', label: 'Shtërpcë' },
  { slug: 'novoberde', label: 'Novobërdë' },
  { slug: 'junik', label: 'Junik' },
  { slug: 'mitrovice-veriut', label: 'Mitrovicë e Veriut' },
  { slug: 'zubin-potok', label: 'Zubin Potok' },
  { slug: 'kllokot', label: 'Kllokot' },
  { slug: 'partesh', label: 'Partesh' },
  { slug: 'ranillug', label: 'Ranillug' },
  { slug: 'mamushe', label: 'Mamushë' },
];

export const TRADE_SLUGS = new Set(TRADES.map((t) => t.slug));
export const TOWN_SLUGS = new Set(TOWNS.map((t) => t.slug));
export const labelOf = (list, slug) => (list.find((x) => x.slug === slug) || { label: slug }).label;

export const LIMITS = { name: 60, about: 600, priceNote: 60, maxTrades: 5, maxTowns: 10, maxYears: 60 };
