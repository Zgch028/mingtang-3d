#!/usr/bin/env node
/* 明堂图 · 可复跑校核器
 * ---------------------------------------------------------------------------
 * 用法：
 *   node verify/verify.cjs                     常规：40 项校核 + 基线漂移检测
 *   node verify/verify.cjs --self-test         自检：注入 4 类篡改，验证比对真能抓到
 *   node verify/verify.cjs --accept-baseline --reason "改了什么、为什么"
 *                                              批准当前数据为新基线（只能用于 index.html）
 *   node verify/verify.cjs --target <文件>      对副本 / 旧版本做检查（此模式不允许批准基线）
 *
 * 退出码：0 全过且无漂移 ｜ 1 有校核失败 ｜ 2 基线漂移未批准 ｜ 3 两者都有
 *
 * 依赖：无。只用 Node 内置模块（fs / path / crypto / child_process）。不需要 npm install。
 *
 * 它做什么：
 *   从 index.html 里抽出 DATA（361 穴的坐标与分级），重新计算一组校核，
 *   输出 verify_report.json。任何人 clone 本仓库后跑一遍，得到的结果应当一致。
 *
 * 它不做什么：
 *   它验的是「数据自身是否自洽」——点数、分级、单侧前提、间距、包络、
 *   以及与界面声明的数字是否一致。
 *   它验不了「穴位是否符合古籍」——那需要文献对照，脚本无能为力。
 *   它也复算不了历史 78 项里的「寸数反算」「贴体表」两类，因为那需要
 *   骨度锚点表与体模几何，这两份中间数据未随本仓库发布（见 report.coverage）。
 *
 * 判定纪律：
 *   每一项都必须能证伪。不能证伪的条目，写成 observation 而不是 check，
 *   不参与 pass/fail 统计——一份只报喜的清单没有意义。
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'verify_report.json');
const BASELINE = path.join(__dirname, 'baseline.json');

/* 阈值集中在处，每一项都写了依据。改阈值等于改标准，请连同依据一起改。 */
const TH = {
  // 横向 1 寸 = 0.0233。0.0040 ≈ 0.17 寸，比实定位最密的一对（0.0086，天髎·附分）
  // 还松一倍，只用来抓「明显叠在一起」，不用于判断解剖细节是否合理。
  minGap: 0.0040,
  // 临床上下相邻穴最近可到 0.5 寸（≈0.0117）。经内实测最小 0.0095（灵道·通里）。
  minGapMeridian: 0.0040,
  // 体模包围盒的合理余量。实测 x[0,0.341] y[-0.880,0.835] z[-0.160,0.148]，
  // 各留 20% 左右余量；超出去说明有坐标被改坏或单位混了。
  envX: [0, 0.42],
  envY: [-1.05, 0.95],
  envZ: [-0.20, 0.20],
  // 坐标统一保留 5 位小数（求解器舍入口径）。若某个值不在 1e-5 网格上，
  // 说明它被手工改过，或来自另一套舍入规则。
  quantum: 1e-5,
  quantumTol: 1e-7,
};

/* ------------------------------------------------- 已知缺陷处置登记 */

/*
 *  这里登记的条目，校核结果**依然是 FAIL**。
 *  登记的是「处置决定」，不是豁免 —— pass 字段一个都不改。
 *
 *  为什么要单独登记：一份 40/40 全绿的报告，读者无从判断阈值是不是被调到
 *  刚好能过。而「有 2 项红着、每项写明根因与修法、并注明是作者决定暂不修」，
 *  读者能自己判断这是诚实还是疏漏。区别就在这张表上。
 *
 *  status 语义：
 *    known-open   已确认、已定位根因、修法已备，作者决定当前版本不修
 *  （将来若修掉，把条目删掉即可；不要改成 known-fixed 留着当装饰。）
 */
const DISPOSITIONS = [
  {
    // 按「缺陷实体」匹配，不按断言名匹配：同一对重合穴会同时触发两条断言
    // （跨经重合 与 两两最近距离），登记一次应当覆盖两条。
    // 用 actual/note 里是否同时出现两个穴名来确认，避免将来别的穴过近时被误标。
    match: c => c.cat === 'G5 重合' && !c.pass &&
      ['actual', 'note'].some(k =>
        String(c[k] || '').includes('阴陵泉') && String(c[k] || '').includes('曲泉')),
    status: 'known-open',
    decided: '2026-11-03',
    decision: 'v1.0 保留不修（作者决定）',
    defect: '阴陵泉（SP）与曲泉（LR）坐标完全重合：[0.0676, -0.4393, 0.065]',
    triggers: '同一缺陷触发两条断言：G5「跨经无完全重合」与「实定位两两最近距离 ≥ 0.004」' +
      '（后者实测 0.0000）。不是两个独立故障。',
    root_cause:
      '下肢求解表中曲泉的方位角误抄为阴陵泉的 150°。同段（膝横纹高度）四穴的方位角应为：' +
      '阴陵泉 150°（胫骨内侧髁下缘）、膝关 165°、曲泉 190°（肌腱内缘）、阴谷 200°（肌腱之间）。',
    detected_by: '本脚本的 G5 跨经重合断言（4 位小数口径，单侧计）',
    missed_by_archive:
      '78 项历史校核未捕获：其中一条叫「经内不重合」，只查同一条经内部；' +
      '而阴陵泉属脾经、曲泉属肝经，跨经，恰好落在七个批次校核的夹缝里。',
    fix_prepared: {
      ready: true,
      target: 'b10_leg_solve.cjs —— 曲泉所在行（SP/LR 同段第 13 寸）的方位角',
      from: { azimuth_deg: 150, coord: [0.0676, -0.4393, 0.065] },
      to: { azimuth_deg: 190, coord: [0.0599, -0.4433, 0.0214] },
      sanity_gap: { to_yingu: '0.49 寸（肌腱内缘到肌腱之间，约半个肌腱宽）', to_xiguan: '1.21 寸' },
      steps: [
        '改 b10_leg_solve.cjs 该行方位角 150 → 190',
        '重跑下肢求解，回写 index.html 的 DATA（曲泉坐标）',
        'node verify/verify.cjs 应得 40/40，且本条目自动消失',
        '重新发布：target.sha256 与版本号随之变化，需同步更新 README 与本报告的 target 段',
      ],
      note: '修法已算出并通过轴点反解验证（复现 base 与段终点差 5e-5），未执行。',
    },
    why_not_fixed: [
      'v1.0 已于 2026-11-03 定版公开。改一个坐标会连带改文件 sha256 与版本号，' +
      '而作品的立身之本是 229 穴的定位方法，不是这一个点。',
      '更重要的是：这 2 项 FAIL 留在公开报告里，是这套校核体系没被松过阈值的证据。' +
      '全绿的清单无法自证严格，红着的清单可以。',
      '界限要说清：这是「记录诚实」，不是「缺陷可以不管」——修法就在上面，谁要修都能修。',
    ],
    reader_impact:
      '视觉上该处两个球叠为一个。界面把所有精确同坐标的穴位收成琥珀数字牌（此处为「2」），' +
      '点击牌面可选组内穴，因此阴陵泉与曲泉仍可分别点开查看，信息可达性未受损，' +
      '代价是多一步点击。该重合处也被列在左侧「全部重合处清单」里。',
  },
];

/* ------------------------------------------------------------------ 工具 */

function extractDATA(html) {
  const MARK = 'const DATA = ';
  const i = html.indexOf(MARK);
  if (i === -1) throw new Error('在 index.html 中找不到 `const DATA = `');
  let depth = 0, end = -1;
  for (let j = i + MARK.length; j < html.length; j++) {
    if (html[j] === '[') depth++;
    else if (html[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end === -1) throw new Error('DATA 的方括号未闭合');
  return JSON.parse(html.slice(i + MARK.length, end + 1));
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const f5 = v => Number(v.toFixed(5));

/* ------------------------------------------------------- 一、自证型校核 */

function runReplayable(html, DATA) {
  const checks = [];
  const observations = [];
  let seq = 0;

  function check(cat, name, pass, expected, actual, unit, formula, note) {
    checks.push({
      id: `R${String(++seq).padStart(3, '0')}`,
      cat, name, pass: !!pass,
      expected, actual, unit: unit || '',
      formula: formula || '',
      note: note || '',
    });
  }
  function observe(name, value, note) {
    observations.push({ name, value, note: note || '' });
  }

  const pts = [];
  for (const m of DATA) for (const p of m.pts) pts.push({ code: m.code, short: m.short, ...p });

  /* ---- G1 结构完备 ------------------------------------------------ */

  check('G1 结构', '经脉数 = 14', DATA.length === 14, 14, DATA.length, '条',
    'DATA.length');

  check('G1 结构', '穴位总数 = 361', pts.length === 361, 361, pts.length, '穴',
    'sum(pts.length)');

  const badFields = pts.filter(p =>
    typeof p.n !== 'string' || !p.n ||
    typeof p.l !== 'string' ||
    !Array.isArray(p.p) || p.p.length !== 3 ||
    typeof p.g !== 'number');
  check('G1 结构', '每点字段齐备（n / l / p[3] / g）', badFields.length === 0,
    0, badFields.length, '个异常点', '逐点检查字段类型与 p 的长度',
    badFields.length ? '异常：' + badFields.slice(0, 5).map(p => p.n || '?').join('、') : '');

  const nonFinite = pts.flatMap(p => p.p).filter(v => !Number.isFinite(v));
  check('G1 结构', '坐标全为有限数（无 NaN / Infinity）', nonFinite.length === 0,
    0, nonFinite.length, '个', 'Number.isFinite(v) for v in p');

  const offGrid = pts.flatMap(p => p.p)
    .filter(v => Math.abs(v / TH.quantum - Math.round(v / TH.quantum)) > TH.quantumTol);
  check('G1 结构', `坐标落在 1e-5 网格上（5 位小数口径）`, offGrid.length === 0,
    `全部在 1e-5 整数倍`, offGrid.length, '个值越格',
    '|v/1e-5 − round(v/1e-5)| ≤ 1e-7',
    offGrid.length ? '越格样例：' + offGrid.slice(0, 5).join(', ') : '');

  const dupNames = new Map();
  for (const p of pts) dupNames.set(p.n, (dupNames.get(p.n) || 0) + 1);
  const dupList = [...dupNames].filter(([, c]) => c > 1);
  check('G1 结构', '穴名全局唯一', dupList.length === 0, 0, dupList.length, '个重名',
    '按 n 计数', dupList.length ? '重名：' + dupList.map(([n]) => n).join('、') : '');

  const shortDesc = pts.filter(p => p.l.trim().length < 2);
  check('G1 结构', '定位描述非空（≥2 字）', shortDesc.length === 0, 0, shortDesc.length, '条',
    'p.l.trim().length >= 2',
    '注：「神阙」的定位就是「脐中央」3 个字，阈值定在 4 字会把它误判成缺失');

  /* ---- G2 分级 --------------------------------------------------- */

  const gCount = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of pts) gCount[p.g] = (gCount[p.g] || 0) + 1;

  const badGrade = Object.keys(gCount).filter(k => !['1', '2', '3', '4'].includes(k));
  check('G2 分级', '分级取值域 ⊆ {1,2,3,4}',
    badGrade.length === 0 && [1, 2, 3, 4].every(g => Number.isInteger(gCount[g])),
    '只有 1..4', Object.keys(gCount).join('/'), '', 'p.g ∈ {1,2,3,4}');

  check('G2 分级', '实定位 g=1 = 229', gCount[1] === 229, 229, gCount[1], '穴',
    'count(p.g === 1)', '界面横幅「实定位 229」的来源');

  check('G2 分级', '待重建 g=2 = 0', gCount[2] === 0, 0, gCount[2], '穴',
    'count(p.g === 2)');

  check('G2 分级', '近似 g=3 = 0', gCount[3] === 0, 0, gCount[3], '穴',
    'count(p.g === 3)');

  check('G2 分级', '示意 g=4 = 132', gCount[4] === 132, 132, gCount[4], '穴',
    'count(p.g === 4)');

  check('G2 分级', '四级之和 = 361', gCount[1] + gCount[2] + gCount[3] + gCount[4] === 361,
    361, gCount[1] + gCount[2] + gCount[3] + gCount[4], '穴', 'Σ counts');

  const pctReal = (gCount[1] / 361 * 100).toFixed(1);
  const pctSch = (gCount[4] / 361 * 100).toFixed(1);
  check('G2 分级', '横幅文案「实定位 229 · 63.4%」与数据一致',
    html.includes(`实定位 229 · 63.4%`) && pctReal === '63.4',
    '229 · 63.4%', `${gCount[1]} · ${pctReal}%`, '', '在 index.html 中检索横幅字符串并比对实算百分比');
  check('G2 分级', '横幅文案「示意 132 · 36.6%」与数据一致',
    html.includes(`示意 132 · 36.6%`) && pctSch === '36.6',
    '132 · 36.6%', `${gCount[4]} · ${pctSch}%`, '', '同上');

  /* ---- G3 单侧前提 ------------------------------------------------ */
  //   DATA 只存单侧坐标，另一侧由浏览器按 x 取反镜像生成。
  //   因此「x ≥ 0」是一条硬前提：一旦出现负值，镜像逻辑会造出叠点。

  const negX = pts.filter(p => p.p[0] < -1e-9);
  check('G3 单侧', '全部轴点 x ≥ 0（镜像由渲染侧生成）', negX.length === 0,
    0, negX.length, '个负值', 'p[0] >= -1e-9',
    negX.length ? '负值：' + negX.slice(0, 5).map(p => p.n).join('、') : '');

  for (const code of ['CV', 'DU']) {
    const m = DATA.find(x => x.code === code);
    const offAxis = m ? m.pts.filter(p => Math.abs(p.p[0]) > 1e-9) : [];
    check('G3 单侧', `${m ? m.short : code} 全部在中线（x = 0）`, m && offAxis.length === 0,
      0, offAxis.length, '个偏离', '|p[0]| <= 1e-9');
  }

  /* ---- G4 经内相邻间距 -------------------------------------------- */
  //  只量「相邻两端都是实定位」的对。示意级共用占位点是有意为之
  //  （「只表大致区域」），拿实定位的尺子去量它，会把设计当成缺陷。
  //  若一条经内不存在 g=1 相邻对，记 observation，不虚报一个"通过"。

  for (const m of DATA) {
    let min = Infinity, pair = '', pairs = 0;
    const skipped = [];
    for (let k = 0; k < m.pts.length - 1; k++) {
      const a = m.pts[k], b = m.pts[k + 1];
      if (a.g !== 1 || b.g !== 1) { skipped.push(`${a.n}·${b.n}`); continue; }
      pairs++;
      const d = dist3(a.p, b.p);
      if (d < min) { min = d; pair = `${a.n}·${b.n}`; }
    }
    if (pairs === 0) {
      observe(`${m.short} 经内无实定位相邻对`, m.pts.length,
        '全经皆为示意级或相邻对跨级，本项不适用');
      continue;
    }
    check('G4 经内间距', `${m.short} 实定位相邻穴最小间距 ≥ ${TH.minGapMeridian}`,
      min >= TH.minGapMeridian, `≥ ${TH.minGapMeridian}`,
      `${min.toFixed(4)}（${pair}）`, '模型单位',
      'min |p[k] − p[k+1]| over 两端皆 g=1 的相邻对',
      `${m.pts.length} 穴，实定位相邻对 ${pairs} 组` +
      (skipped.length ? `；跳过跨级对 ${skipped.length} 组` : ''));
  }

  /* ---- G5 重合：实定位不允许，示意级允许但必须计数 ---------------- */

  //  口径：按 4 位小数归组（与工程报告一致）。单侧计，不重复计镜像侧。
  const groups = new Map();
  for (const p of pts) {
    const key = p.p.map(v => v.toFixed(4)).join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const multi = [...groups.entries()].filter(([, v]) => v.length > 1);

  const g1DupInMeridian = multi.filter(([, v]) =>
    v.every(x => x.g === 1) && new Set(v.map(x => x.code)).size === 1);
  const g1DupCross = multi.filter(([, v]) =>
    v.every(x => x.g === 1) && new Set(v.map(x => x.code)).size > 1);

  check('G5 重合', '实定位（g=1）经内无完全重合', g1DupInMeridian.length === 0,
    0, g1DupInMeridian.length, '组', '按 4 位小数归组，组内全 g=1 且同经',
    g1DupInMeridian.map(([, v]) => v.map(x => x.n).join('/')).join('；'));

  check('G5 重合', '实定位（g=1）跨经无完全重合', g1DupCross.length === 0,
    0, g1DupCross.length, '组', '按 4 位小数归组，组内全 g=1 且跨经',
    g1DupCross.map(([, v]) => v.map(x => `${x.n}(${x.code})`).join(' / ')).join('；'));

  // g=1 两两间距（不重合、也不过近）
  let g1Min = Infinity, g1Pair = '';
  const g1 = pts.filter(p => p.g === 1);
  for (let a = 0; a < g1.length; a++) {
    for (let b = a + 1; b < g1.length; b++) {
      const d = dist3(g1[a].p, g1[b].p);
      if (d < g1Min) { g1Min = d; g1Pair = `${g1[a].n}·${g1[b].n}`; }
    }
  }
  check('G5 重合', `实定位两两最近距离 ≥ ${TH.minGap}`, g1Min >= TH.minGap,
    `≥ ${TH.minGap}`, `${g1Min.toFixed(4)}（${g1Pair}）`, '模型单位',
    `min over ${g1.length}² pairs`);

  // 示意级：不判 pass/fail，只记录（共用占位点是设计使然）
  const g4Groups = multi.filter(([, v]) => v.some(x => x.g === 4));
  const g4Involved = g4Groups.reduce((s, [, v]) => s + v.filter(x => x.g === 4).length, 0);
  observe('示意级重合组数（4 位小数口径，单侧）', g4Groups.length,
    `涉及 ${g4Involved} / ${gCount[4]} 个示意级穴位；共用占位点是「只表大致区域」的显式结果，界面以琥珀数字标出`);
  observe('示意级最大单组', Math.max(0, ...g4Groups.map(([, v]) => v.length)),
    g4Groups.length ? '最大一组：' + [...g4Groups].sort((a, b) => b[1].length - a[1].length)[0][1].map(x => x.n).join('、') : '');

  /* ---- G6 包围盒 --------------------------------------------------- */

  const xs = pts.map(p => p.p[0]), ys = pts.map(p => p.p[1]), zs = pts.map(p => p.p[2]);
  const bb = {
    x: [Math.min(...xs), Math.max(...xs)],
    y: [Math.min(...ys), Math.max(...ys)],
    z: [Math.min(...zs), Math.max(...zs)],
  };
  check('G6 包络', `x ∈ [${TH.envX[0]}, ${TH.envX[1]}]`,
    bb.x[0] >= TH.envX[0] && bb.x[1] <= TH.envX[1],
    `[${TH.envX[0]}, ${TH.envX[1]}]`, `[${bb.x[0].toFixed(3)}, ${bb.x[1].toFixed(3)}]`, '',
    'min / max of p[0]');
  check('G6 包络', `y ∈ [${TH.envY[0]}, ${TH.envY[1]}]`,
    bb.y[0] >= TH.envY[0] && bb.y[1] <= TH.envY[1],
    `[${TH.envY[0]}, ${TH.envY[1]}]`, `[${bb.y[0].toFixed(3)}, ${bb.y[1].toFixed(3)}]`, '',
    'min / max of p[1]');
  check('G6 包络', `z ∈ [${TH.envZ[0]}, ${TH.envZ[1]}]`,
    bb.z[0] >= TH.envZ[0] && bb.z[1] <= TH.envZ[1],
    `[${TH.envZ[0]}, ${TH.envZ[1]}]`, `[${bb.z[0].toFixed(3)}, ${bb.z[1].toFixed(3)}]`, '',
    'min / max of p[2]');

  /* ---- G7 胸肋 rb 字段 -------------------------------------------- */
  //  rb 有两种形态，别只认第一种：
  //    肋间穴 {n: 0.5|1..7, cu: 旁开寸}  —— n=0.5 是「第 1 肋间隙」的半肋写法
  //        （云门 / 气户 / 俞府，锁骨下三穴；v8 曾专门为这个 0.5 改过弹窗文案）
  //    肋端穴 {end: 11|12}             —— 章门在第 11 肋端、京门在第 12 肋端
  const rbPts = pts.filter(p => p.rb);
  const badRb = rbPts.filter(p => {
    const r = p.rb;
    if (typeof r.end === 'number') return !(Number.isInteger(r.end) && r.end >= 11 && r.end <= 12);
    if (typeof r.n === 'number') {
      const okN = (r.n === 0.5) || (Number.isInteger(r.n) && r.n >= 1 && r.n <= 12);
      const okCu = typeof r.cu === 'number' && r.cu >= 0 && r.cu <= 12;
      return !(okN && okCu);
    }
    return true;
  });
  check('G7 胸肋', 'rb 结构合法（肋间 n=0.5|1–12、旁开 0–12 寸；肋端 end=11|12）',
    badRb.length === 0, 0, badRb.length, '个异常',
    'p.rb = {n, cu} 或 {end}',
    badRb.length ? badRb.slice(0, 6).map(p => `${p.n}(${JSON.stringify(p.rb)})`).join('、') : '');

  check('G7 胸肋', '含 rb 的穴位 = 26（胸肋批）', rbPts.length === 26, 26, rbPts.length, '穴',
    'count(p.rb != null)');

  /* ---- G8 指纹 ----------------------------------------------------- */

  // 不算校核，只登记「这次验的是哪一份文件」。

  return { checks, observations, bb, gCount, g1Min, g1Pair };
}

/* --------------------------------------------------- 二、历史 78 项归档 */

const BATCHES = [
  { id: 'b1u', file: 'limb_upper_v1.json', name: '批次一·上 上肢主干（6 经 44 穴）', expect: 6, kind: 'dict' },
  { id: 'b1d', file: 'limb_leg_v1.json', name: '批次一·下 下肢主干（6 经 48 穴）', expect: 6, kind: 'list' },
  { id: 'b2', file: 'spine_v1.json', name: '批次二 脊柱组（53 穴）', expect: 10, kind: 'list' },
  { id: 'b3', file: 'ribs_v1.json', name: '批次三 胸肋（26 穴）', expect: 9, kind: 'list' },
  { id: 'b4', file: 'trunk_v1.json', name: '批次四 躯干旁开（43 穴）', expect: 13, kind: 'list' },
  { id: 'b5', file: 'shoulder_v1.json', name: '批次五 肩带（12 穴）', expect: 15, kind: 'list' },
  { id: 'b6', file: 'pelvis_v1.json', name: '批次六 骨盆（3 穴）', expect: 14, kind: 'list' },
  { id: 'b7', file: 'juliao_v1.json', name: '居髎复核', expect: 5, kind: 'list' },
];

/* limb_upper 的 checks 是一个聚合对象，不是逐项列表；这里按 6 项还原，
   阈值取自该批求解时使用的口径。 */
function upperSix(c) {
  const items = [];
  items.push(['沿经纵序单调（段内不翻转）', c.monotonic === true,
    c.monotonic ? '无翻转' : '存在翻转']);
  items.push(['左右对称（轴点 x>0，镜像由渲染生成）', c.symmetric === true,
    c.symmetric ? '全部轴点 x>0' : '存在 x≤0 的轴点']);
  items.push(['寸数反算（从坐标反推寸数）', typeof c.cunMaxErr === 'number' && c.cunMaxErr < 1e-9,
    `最大误差 ${Number(c.cunMaxErr).toExponential(2)} 寸`]);
  items.push(['贴体表（法向偏移量）', typeof c.surfaceMaxErr === 'number' && c.surfaceMaxErr < 1e-3,
    `最大偏差 ${Number(c.surfaceMaxErr).toExponential(2)}`]);
  items.push(['经内不重合', typeof c.minGap === 'number' && c.minGap >= 0.004,
    `最小间距 ${c.minGap}（${c.minPair}）`]);
  items.push(['无落入躯干', c.inTrunk === 0, `落入躯干 ${c.inTrunk} 点`]);
  return items;
}

/* 复跑条件归类：告诉读者「这一项要重算还缺什么」。 */
function needsOf(label) {
  const s = label;
  if (/反算|寸|弧长|旁开/.test(s)) return '骨度锚点表（未随仓库发布）';
  if (/体表|贴|埋|浮|穿|余量|遮挡|凸出/.test(s)) return '体模几何（未随仓库发布）';
  if (/重合|间距|不冲突/.test(s)) return '仅需坐标——已由 replayable 的 G5 覆盖';
  if (/对称/.test(s)) return '需渲染侧镜像（单侧前提已由 G3 覆盖）';
  if (/单调|递减|递增|椎节|肋间|平脐|平椎节/.test(s)) return '骨度锚点表（未随仓库发布）';
  if (/覆盖/.test(s)) return '源数据集对照（未随仓库发布）';
  return '需该批求解中间数据（未随仓库发布）';
}

function buildArchive(dir) {
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('归档源目录不存在：' + dir);
  }
  const out = [];
  let n = 0;
  for (const b of BATCHES) {
    const f = path.join(dir, b.file);
    if (!fs.existsSync(f)) throw new Error('缺少批次文件：' + f);
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    let items;
    if (b.kind === 'dict') {
      items = upperSix(d.checks);
    } else {
      items = d.checks.map(c => [
        c.label || c.name || c.n || '（未命名）',
        c.ok === true,
        c.detail || c.msg || c.note || (c.v !== undefined ? String(c.v) : ''),
      ]);
    }
    if (items.length !== b.expect) {
      throw new Error(`${b.file}：提取 ${items.length} 项，期望 ${b.expect} 项`);
    }
    for (const [name, pass, evidence] of items) {
      out.push({
        id: `A${String(++n).padStart(3, '0')}`,
        batch: b.id,
        batch_name: b.name,
        name,
        pass: !!pass,
        evidence: String(evidence || ''),
        replayable: false,
        needs: needsOf(name),
      });
    }
  }
  return out;
}

/* ------------------------------------------------ 二、基线漂移检测 */

/*
 *  为什么还要一份基线：校核器能证明「当前这一份数据是否自洽」，
 *  但证明不了「它是不是上一次批准过的那一份」。所以另存一份被批准的
 *  坐标基线（baseline.json），每次跑都逐穴比对。
 *
 *  三条设计纪律，都是为了让告警不退化成噪音：
 *
 *   1) 按「数据」比，不按「文件」比。
 *      改一句界面文字不该触发坐标告警。数据指纹只由 361 穴的
 *      (code, name, p, g) 算出；文件 sha 只作记录，不参与漂移判定。
 *
 *   2) 差异必须定位到穴。
 *      只说「文件变了」等于没说。要列出改了哪几个穴、从哪到哪、移动多少寸。
 *
 *   3) 必须有出口。
 *      有意改动用 --accept-baseline --reason "..." 更新基线并留痕，
 *      之后自动恢复 clean。一个永远红着、且没法变绿的告警，
 *      最后一定会被所有人忽略——那比没有告警更糟。
 */

function pointIndex(DATA) {
  const idx = new Map();
  for (const m of DATA) for (const p of m.pts) {
    idx.set(`${m.code}|${p.n}`, {
      code: m.code, n: p.n, g: p.g,
      p: p.p.map(v => Number(v.toFixed(5))),   // 统一到求解器舍入口径
    });
  }
  return idx;
}

function fingerprint(idx) {
  const rows = [...idx.keys()].sort().map(k => {
    const v = idx.get(k);
    return `${k}:${v.g}:${v.p.join(',')}`;
  });
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

function diffBaseline(baseIdx, curIdx) {
  const modified = [], gradeChanged = [], added = [], removed = [];
  for (const [k, cur] of curIdx) {
    const b = baseIdx.get(k);
    if (!b) { added.push({ code: cur.code, n: cur.n, g: cur.g, p: cur.p }); continue; }
    if (cur.p.some((v, i) => Math.abs(v - b.p[i]) > 1e-9)) {
      const d = Math.hypot(cur.p[0] - b.p[0], cur.p[1] - b.p[1], cur.p[2] - b.p[2]);
      modified.push({
        code: cur.code, n: cur.n, g: cur.g,
        from: b.p, to: cur.p,
        dist: Number(d.toFixed(5)),
        cun: Number((d / 0.0233).toFixed(2)),   // 横向 1 寸，供人读
      });
    }
    if (cur.g !== b.g) gradeChanged.push({ code: cur.code, n: cur.n, from: b.g, to: cur.g });
  }
  for (const [k, b] of baseIdx) if (!curIdx.has(k)) removed.push({ code: b.code, n: b.n, g: b.g, p: b.p });
  const cmp = (a, b) => a.n.localeCompare(b.n) || a.code.localeCompare(b.code);
  modified.sort(cmp); added.sort(cmp); removed.sort(cmp); gradeChanged.sort(cmp);
  return { modified, added, removed, grade_changed: gradeChanged };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

function gitUser() {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch { return 'unknown'; }
}

function writeBaseline(DATA, idx, fp, sha256, gCount, reason, prev) {
  const diff = prev ? diffBaseline(new Map(prev.points.map(x => [`${x.code}|${x.n}`, x])), idx) : null;
  const base = {
    schema: 'mingtang-baseline/1',
    approved_at: new Date().toISOString(),
    target: { file: 'index.html', file_sha256: sha256, data_fingerprint: fp, points: idx.size },
    grade_counts: gCount,
    // 逐穴坐标：这是「被批准的坐标」本身，独立于 index.html 存在。
    points: [...idx.values()],
    history: [
      ...(prev ? prev.history : []),
      {
        at: new Date().toISOString(),
        by: gitUser(),
        reason: reason || '(未提供理由 —— 应当补上)',
        data_fingerprint: fp,
        file_sha256: sha256,
        first: !prev,
        changes: diff ? {
          modified: diff.modified.length,
          added: diff.added.length,
          removed: diff.removed.length,
          grade_changed: diff.grade_changed.length,
          detail: diff.modified.map(x => `${x.n}(${x.code}) 移动 ${x.cun} 寸`)
            .concat(diff.removed.map(x => `删除 ${x.n}(${x.code})`))
            .concat(diff.added.map(x => `新增 ${x.n}(${x.code})`))
            .concat(diff.grade_changed.map(x => `${x.n}(${x.code}) 分级 ${x.from}→${x.to}`)),
        } : null,
      },
    ],
  };
  fs.writeFileSync(BASELINE, JSON.stringify(base, null, 2) + '\n', 'utf8');
  return base;
}

/* ---- 校核器的自检：注入篡改，确认上面这套比对真的能抓到 -------------- */

function selfTest(DATA) {
  const t = JSON.parse(JSON.stringify(DATA));
  const pick = (code, name) => {
    for (const m of t) if (m.code === code) for (const p of m.pts) if (p.n === name) return p;
    return null;
  };
  // ① 坐标微小偏移（0.01，约 0.43 寸 —— 肉眼几乎看不出，但足以改变定位）
  pick('ST', '足三里').p[1] = Number((pick('ST', '足三里').p[1] + 0.01).toFixed(5));
  // ② 分级被改（实定位 → 示意）
  pick('LR', '曲泉').g = 4;
  // ③ 删掉一个穴
  const lu = t.find(m => m.code === 'LU');
  lu.pts = lu.pts.filter(p => p.n !== '少商');
  // ④ 新增一个穴
  lu.pts.push({ n: '不存在穴', l: '自检注入', p: [0.1, 0.2, 0.0], g: 4 });

  const baseIdx = pointIndex(DATA);
  const curIdx = pointIndex(t);
  const d = diffBaseline(baseIdx, curIdx);

  const cases = [
    ['坐标偏移能检出（足三里 · 0.43 寸）', d.modified.length === 1 && d.modified[0].n === '足三里'],
    ['分级变化能检出（曲泉 1→4）', d.grade_changed.length === 1 && d.grade_changed[0].n === '曲泉'],
    ['删除穴位能检出（少商）', d.removed.length === 1 && d.removed[0].n === '少商'],
    ['新增穴位能检出（不存在穴）', d.added.length === 1 && d.added[0].n === '不存在穴'],
    ['未注入改动的穴不误报', d.modified.length + d.removed.length + d.grade_changed.length === 3],
    ['数据指纹随改动而变', fingerprint(baseIdx) !== fingerprint(curIdx)],
  ];
  return { cases, diff: d };
}

/* ------------------------------------------------------------ 主流程 */

function main() {
  const argv = process.argv.slice(2);
  const ai = argv.indexOf('--rebuild-archive');
  const archiveDir = ai >= 0 ? argv[ai + 1] : null;

  const accept = argv.includes('--accept-baseline');
  const ri = argv.indexOf('--reason');
  const reason = ri >= 0 ? argv[ri + 1] : null;

  /* --target：默认 index.html。可指向副本或旧版本文件做检查 / 对比。
     但批准基线只允许针对 index.html —— 否则基线会指向一个不存在于仓库
     发布路径上的文件，等于废掉这份基线。 */
  const ti = argv.indexOf('--target');
  const target = ti >= 0 ? path.resolve(argv[ti + 1]) : TARGET;
  if (accept && path.resolve(target) !== path.resolve(TARGET)) {
    console.error('✗ --accept-baseline 只能用于 index.html，不能用于 --target 指定的文件。');
    console.error('  基线必须指向仓库对外发布的那个文件，否则形同虚设。');
    process.exitCode = 1;
    return;
  }
  if (ti >= 0 && !accept) console.log('（目标文件：' + path.relative(ROOT, target) + '）');

  /* 自检：不写任何文件，只在内存里篡改一份副本，验证比对逻辑真能抓到 */
  if (argv.includes('--self-test')) {
    const DATA0 = extractDATA(fs.readFileSync(TARGET, 'utf8'));
    const { cases, diff } = selfTest(DATA0);
    console.log('');
    console.log('基线漂移检测 · 自检（注入 4 类篡改，均为内存副本，不落盘）');
    for (const [name, ok] of cases) console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
    console.log('');
    console.log('  检出明细：移动 ' + diff.modified.map(x => x.n + ' ' + x.cun + ' 寸').join('、'));
    console.log('            分级 ' + diff.grade_changed.map(x => `${x.n} ${x.from}→${x.to}`).join('、'));
    console.log('            删除 ' + diff.removed.map(x => x.n).join('、') +
                '　新增 ' + diff.added.map(x => x.n).join('、'));
    console.log('');
    process.exitCode = cases.every(([, ok]) => ok) ? 0 : 1;
    return;
  }

  const buf = fs.readFileSync(target);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const html = buf.toString('utf8');
  const DATA = extractDATA(html);
  const { checks, observations, bb, gCount, g1Min, g1Pair } = runReplayable(html, DATA);

  /* ---- 基线漂移判定 -------------------------------------------------- */

  const curIdx = pointIndex(DATA);
  const fp = fingerprint(curIdx);
  const prevBase = readBaseline();
  const mapOf = arr => new Map(arr.map(x => [`${x.code}|${x.n}`, x]));

  let drift;
  if (accept) {
    const nb = writeBaseline(DATA, curIdx, fp, sha256, gCount, reason, prevBase);
    const h = nb.history[nb.history.length - 1];
    drift = {
      status: 'accepted',
      note: '基线已更新（本次改动被批准，后续运行将恢复 clean）',
      approved_at: nb.approved_at,
      by: h.by, reason: h.reason,
      changes: h.changes,
    };
    console.log('');
    console.log('基线已更新：' + (prevBase ? 'diff 见下方 drift.changes' : '首版基线') +
      '　理由：' + h.reason);
  } else if (!prevBase) {
    drift = {
      status: 'no-baseline',
      note: '缺少 baseline.json，无法判断数据是否被改动',
      how: 'node verify/verify.cjs --accept-baseline --reason "建立基线的原因"',
    };
  } else if (prevBase.target.data_fingerprint !== fp) {
    const d = diffBaseline(mapOf(prevBase.points), curIdx);
    drift = {
      status: 'unreviewed',
      note: '361 穴数据与已批准基线不一致，且尚未被批准',
      baseline: {
        approved_at: prevBase.approved_at,
        data_fingerprint: prevBase.target.data_fingerprint,
        points: prevBase.points.length,
      },
      counts: {
        modified: d.modified.length, added: d.added.length,
        removed: d.removed.length, grade_changed: d.grade_changed.length,
      },
      modified: d.modified, added: d.added, removed: d.removed,
      grade_changed: d.grade_changed,
      how: '若改动是有意的：node verify/verify.cjs --accept-baseline --reason "改了什么、为什么"',
    };
  } else {
    drift = {
      status: 'clean',
      note: '361 穴数据与已批准基线逐穴一致',
      baseline: { approved_at: prevBase.approved_at, points: prevBase.points.length },
      // 文件 sha 变了但数据没变 —— 说明改的是界面/文案，不该当坐标告警
      file_changed_only: prevBase.target.file_sha256 !== sha256,
    };
    if (drift.file_changed_only) {
      drift.file_note = 'index.html 的文件 sha 变了，但 361 穴数据未变（多半是界面或文案改动），不计为数据漂移。';
    }
  }

  /* 归档：给了 --rebuild-archive 就重建；否则沿用上一份报告里的归档，
     并在 sha 不匹配时提示归档可能已过期。 */
  let archive = [];
  let archiveBasedOn = null;
  let archiveStale = false;
  if (archiveDir) {
    archive = buildArchive(archiveDir);
    archiveBasedOn = sha256;
    console.log(`归档已重建：${archive.length} 项（源：${archiveDir}）`);
  } else if (fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    archive = prev.archive || [];
    archiveBasedOn = (prev.archive_meta && prev.archive_meta.based_on_sha256) || null;
    archiveStale = archiveBasedOn !== sha256 && archive.length > 0;
  }

  /* 实定位两两最近 5 对：不是判定，是给人看的。 */
  const g1 = [];
  for (const m of DATA) for (const p of m.pts) if (p.g === 1) g1.push({ code: m.code, ...p });
  const pairs = [];
  for (let a = 0; a < g1.length; a++) {
    for (let b = a + 1; b < g1.length; b++) {
      pairs.push([dist3(g1[a].p, g1[b].p), `${g1[a].n}(${g1[a].code})·${g1[b].n}(${g1[b].code})`]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const g1Nearest = pairs.slice(0, 8).map(([d, s]) => ({
    pair: s,
    dist: f5(d),
    cun: Number((d / 0.0233).toFixed(2)),
    // < 0.5 寸就不该再当"正常"，交给人判断：是解剖事实（相邻穴本就近），
    // 还是体模缺陷（如腿胶囊顶端把横骨上廉/大转子/臀沟截成了同一截面）。
    flag: d < 0.5 * 0.0233 ? '过近，待人工判断' : '',
  }));

  /* ---- 标注已知缺陷的处置状态（不动 pass） -------------------------- */

  let knownOpen = 0;
  for (const c of checks) {
    if (c.pass) continue;                     // 处置登记只针对仍然失败的条目
    const d = DISPOSITIONS.find(x => x.match(c));
    if (!d) continue;
    const { match, ...payload } = d;          // match 是函数，不写进 JSON
    c.disposition = payload;
    knownOpen++;
  }

  const pass = checks.filter(c => c.pass).length;
  const fail = checks.length - pass;
  const unexplained = fail - knownOpen;
  const archPass = archive.filter(c => c.pass).length;

  const report = {
    schema: 'mingtang-verify/1',
    title: '明堂图 · 可复跑校核报告',
    generated_at: new Date().toISOString(),
    target: {
      file: 'index.html',
      bytes: buf.length,
      sha256,
      points: DATA.reduce((s, m) => s + m.pts.length, 0),
    },
    declaration: {
      real: { grade: 1, count: gCount[1], pct: (gCount[1] / 361 * 100).toFixed(1) },
      pending: { grade: 2, count: gCount[2] },
      approximate: { grade: 3, count: gCount[3] },
      schematic: { grade: 4, count: gCount[4], pct: (gCount[4] / 361 * 100).toFixed(1) },
      total: 361,
    },
    summary: {
      replayable: { total: checks.length, pass, fail, known_open: knownOpen, unexplained },
      archive: { total: archive.length, pass: archPass, fail: archive.length - archPass },
      // verdict 不做美化：有失败就是 FAIL，不因「已知」而改写成别的词。
      verdict: fail === 0 ? 'PASS' : 'FAIL',
      verdict_note: fail === 0 ? ''
        : (unexplained === 0
            ? `${fail} 项未通过，均为已登记的已知缺陷（见 disposition 字段），无未解释失败。`
            : `${fail} 项未通过：${knownOpen} 项为已登记的已知缺陷，${unexplained} 项为未解释失败。`),
    },
    // 处置登记的完整副本，便于读者不必翻 replayable 也能看到全貌
    dispositions: DISPOSITIONS.map(({ match, ...d }) => d),
    drift,
    thresholds: TH,
    replayable: checks,
    observations,
    archive,
    archive_meta: {
      based_on_sha256: archiveBasedOn,
      stale: archiveStale,
      batches: BATCHES.map(b => ({ id: b.id, name: b.name, count: b.expect })),
    },
    coverage: {
      note: 'replayable 是本次从 index.html 现场重算的校核；archive 是七个批次求解当时的 78 项记录。' +
            '两者不是子集关系：archive 的多数条目需要未发布的中间数据才能复算，replayable 则是任何人都能跑的部分。',
      replayable_scope: '数据自洽：点数、分级、单侧前提、间距、重合、包络、胸肋字段、界面文案一致性',
      not_replayable: [
        { kind: '寸数反算 / 旁开弧长反算', reason: '需要骨度锚点表（各段起止点与寸长），未随仓库发布' },
        { kind: '贴体表 / 骨标埋入 / 不穿出', reason: '需要体模几何（胶囊与球的参数），未随仓库发布' },
      ],
    },
    nearest_g1: g1Nearest,
    bounds: {
      x: bb.x.map(f5), y: bb.y.map(f5), z: bb.z.map(f5),
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  /* 控制台摘要 */
  const L = [];
  L.push('');
  L.push('明堂图 · 可复跑校核    target sha256 ' + sha256.slice(0, 16) + '…');
  L.push('  实定位 ' + gCount[1] + ' / 待重建 ' + gCount[2] + ' / 近似 ' + gCount[3] + ' / 示意 ' + gCount[4] + '（共 361）');
  L.push('  自算校核 ' + checks.length + ' 项：通过 ' + pass + (fail ? '，**失败 ' + fail + '**' : '，全部通过'));
  if (archive.length) L.push('  历史归档 ' + archive.length + ' 项：通过 ' + archPass);
  if (fail) {
    L.push('');
    L.push('  ── 未通过 ' + fail + ' 项（已登记已知缺陷 ' + knownOpen + ' / 未解释 ' + unexplained + '）──');
    for (const c of checks.filter(x => !x.pass)) {
      const tag = c.disposition ? `[已知 · ${c.disposition.decision}]` : '[未解释]';
      L.push(`  ✗ ${tag} [${c.id}] ${c.name}`);
      L.push(`      期望 ${c.expected}　实测 ${c.actual}`);
      if (c.note) L.push(`      ${c.note}`);
      if (c.disposition) L.push(`      → 处置登记见 verify_report.json 的 dispositions 段`);
    }
  }
  if (archiveStale) L.push('  ⚠ 归档对应的 sha 与当前文件不一致，归档可能已过期（用 --rebuild-archive 重建）');

  /* 基线漂移 */
  L.push('');
  if (drift.status === 'clean') {
    L.push('  基线漂移 ✓ clean —— 361 穴与基线逐穴一致' +
      (drift.file_changed_only ? '（文件 sha 已变：' + drift.file_note + '）' : ''));
  } else if (drift.status === 'accepted') {
    L.push('  基线漂移 ✓ accepted —— 本次改动已批准并入基线');
    if (drift.changes && drift.changes.detail && drift.changes.detail.length) {
      L.push('      变更：' + drift.changes.detail.join('；'));
    }
  } else if (drift.status === 'no-baseline') {
    L.push('  基线漂移 ⚠ 无基线 —— ' + drift.note);
    L.push('      ' + drift.how);
  } else {
    L.push('  基线漂移 ✗ unreviewed —— 数据与基线不一致，且尚未批准');
    L.push(`      基线批准于 ${(drift.baseline.approved_at || '').slice(0, 10)}，共 ${drift.baseline.points} 穴`);
    L.push(`      差异：移动 ${drift.counts.modified} · 分级 ${drift.counts.grade_changed}` +
      ` · 新增 ${drift.counts.added} · 删除 ${drift.counts.removed}`);
    for (const x of drift.modified.slice(0, 10)) {
      L.push(`        · ${x.n}(${x.code})  ${x.cun} 寸  [${x.from.join(', ')}] → [${x.to.join(', ')}]`);
    }
    for (const x of drift.grade_changed.slice(0, 10)) {
      L.push(`        · ${x.n}(${x.code})  分级 ${x.from} → ${x.to}`);
    }
    for (const x of drift.removed.slice(0, 10)) L.push(`        · 已删除 ${x.n}(${x.code})`);
    for (const x of drift.added.slice(0, 10)) L.push(`        · 新增 ${x.n}(${x.code})`);
    L.push('      ' + drift.how);
  }

  L.push('');
  L.push('  → ' + path.relative(process.cwd(), OUT));
  L.push('');
  console.log(L.join('\n'));

  // 退出码可区分：1 = 校核失败，2 = 基线漂移未批准，3 = 两者都有。
  const driftBad = drift.status === 'unreviewed' || drift.status === 'no-baseline';
  process.exitCode = (fail ? 1 : 0) + (driftBad ? 2 : 0);
}

main();
