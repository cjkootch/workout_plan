import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

// ===== TOOLS =====
const TOOLS = [
  {
    name: 'log_set',
    description: `Log a completed exercise set to the workout database.
Use this whenever Cole says he finished a set — e.g. "just did 225×5 bench", "hit 3 sets of RDL at 245 for 8".
Log each set separately (multiple tool calls if multiple sets).
Automatically assigns today's date and marks the set as done.`,
    input_schema: {
      type: 'object',
      properties: {
        exercise_name: {
          type: 'string',
          description: 'Exact exercise name from the program. Must match one of: Barbell Flat Bench Press, Incline DB Press, Cable Fly (Low to High), Seated DB Overhead Press, Lateral Raise (Cable or DB), Overhead Cable Tricep Extension, Tricep Rope Pushdown, Barbell Bent-Over Row, Seated Cable Row (Wide Grip), Single-Arm DB Row, TRX Row (Feet Elevated), Lat Pulldown (Wide Overhand), Straight-Arm Cable Pulldown, Barbell Curl, Incline DB Curl, Hammer Curl, Barbell Back Squat, Leg Press (High & Wide Foot), Bulgarian Split Squat (DB), Romanian Deadlift (Bar), Lying Leg Curl, Hip Thrust (Barbell), Leg Extension, Face Pull (Cable), DB Lateral Raise (Drop Set), Arnold Press, Preacher Curl (EZ Bar), Cable Curl (Both Arms), DB Concentration Curl, Close-Grip Bench Press, Skull Crusher (EZ Bar), Single-Arm Cable Pushdown, Cable Crunch, Hanging Leg Raise, Ab Wheel Rollout, KB Goblet Squat, KB Swing (Two-Hand), KB Turkish Get-Up, Plank Variations, Pallof Press (Cable), Dead Bug',
        },
        day_key: {
          type: 'string',
          enum: ['day1', 'day2', 'day3', 'day4', 'day5'],
          description: 'day1=Push, day2=Pull, day3=Legs, day4=Upper Power/Arms, day5=Athletic',
        },
        weight: {
          type: 'number',
          description: 'Weight used in lbs (use 0 for bodyweight exercises)',
        },
        reps: {
          type: 'number',
          description: 'Number of reps completed',
        },
      },
      required: ['exercise_name', 'day_key', 'weight', 'reps'],
    },
  },
  {
    name: 'log_bodyweight',
    description: "Log Cole's bodyweight. Use whenever he mentions his current weight or a recent weigh-in.",
    input_schema: {
      type: 'object',
      properties: {
        weight: {
          type: 'number',
          description: 'Bodyweight in lbs',
        },
      },
      required: ['weight'],
    },
  },
  {
    name: 'get_exercise_history',
    description: 'Fetch recent set-by-set history for a specific exercise. Use when Cole asks about progress on a lift, wants to know his recent numbers, or when you need more granular data than the system prompt provides.',
    input_schema: {
      type: 'object',
      properties: {
        exercise_name: {
          type: 'string',
          description: 'Exercise name to query (partial match supported)',
        },
        sessions: {
          type: 'number',
          description: 'Number of recent sessions to return (default 5)',
        },
      },
      required: ['exercise_name'],
    },
  },
];

// ===== TOOL EXECUTION =====
async function executeTool(name, input, sql) {
  switch (name) {

    case 'log_set': {
      const { exercise_name, day_key, weight, reps } = input;
      // Auto-increment set_index for today
      const [{ max_idx }] = await sql`
        SELECT COALESCE(MAX(set_index), -1) AS max_idx
        FROM workout_sets
        WHERE workout_date = CURRENT_DATE
          AND exercise_name = ${exercise_name}
      `;
      const nextIdx = (Number(max_idx) ?? -1) + 1;
      await sql`
        INSERT INTO workout_sets
          (workout_date, day_key, exercise_name, set_index, weight, reps, done, updated_at)
        VALUES
          (CURRENT_DATE, ${day_key}, ${exercise_name}, ${nextIdx},
           ${weight || null}, ${String(reps)}, true, NOW())
        ON CONFLICT (workout_date, day_key, exercise_name, set_index)
        DO UPDATE SET
          weight = EXCLUDED.weight,
          reps   = EXCLUDED.reps,
          done   = true,
          updated_at = NOW()
      `;
      return `Logged set ${nextIdx + 1}: ${exercise_name} — ${weight} lbs × ${reps} reps ✓`;
    }

    case 'log_bodyweight': {
      const { weight } = input;
      await sql`
        INSERT INTO bodyweight_logs (log_date, weight)
        VALUES (CURRENT_DATE, ${weight})
      `;
      return `Bodyweight logged: ${weight} lbs ✓`;
    }

    case 'get_exercise_history': {
      const { exercise_name, sessions = 5 } = input;
      const rows = await sql`
        SELECT workout_date::text, weight::float, reps, set_index
        FROM workout_sets
        WHERE exercise_name ILIKE ${'%' + exercise_name + '%'}
          AND done = true
          AND weight IS NOT NULL
        ORDER BY workout_date DESC, set_index
        LIMIT ${sessions * 6}
      `;
      if (!rows.length) return `No history found for "${exercise_name}"`;
      const byDate = {};
      rows.forEach(r => {
        if (!byDate[r.workout_date]) byDate[r.workout_date] = [];
        byDate[r.workout_date].push(`${r.weight}×${r.reps}`);
      });
      return Object.entries(byDate)
        .slice(0, sessions)
        .map(([date, sets]) => `${date}: ${sets.join(', ')}`)
        .join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ===== SYSTEM PROMPT =====
function buildSystemPrompt(recentRows, prRows, bwRows, overview, phase = 'bulk') {
  const sessions = {};
  recentRows.forEach(r => {
    if (!sessions[r.workout_date]) sessions[r.workout_date] = {};
    if (!sessions[r.workout_date][r.day_key]) sessions[r.workout_date][r.day_key] = {};
    if (!sessions[r.workout_date][r.day_key][r.exercise_name]) sessions[r.workout_date][r.day_key][r.exercise_name] = [];
    sessions[r.workout_date][r.day_key][r.exercise_name].push({ weight: r.weight, reps: r.reps });
  });

  let sessionsText = '';
  Object.entries(sessions)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([date, days]) => {
      Object.entries(days).forEach(([day, exercises]) => {
        sessionsText += `\n${date} (${day}):\n`;
        Object.entries(exercises).forEach(([ex, sets]) => {
          const setStr = sets.map(s => `${s.weight || '?'}×${s.reps || '?'}`).join(', ');
          sessionsText += `  ${ex}: ${setStr}\n`;
        });
      });
    });

  const prsText = prRows.map(r => `  ${r.exercise_name}: ${r.weight} lbs × ${r.reps} (${r.date})`).join('\n');
  const bwText  = bwRows.map(r => `  ${r.date}: ${r.weight} lbs`).join('\n');
  const latestBW = bwRows[0]?.weight;

  return `You are Cole's personal fitness coach AI, built into his Iron Protocol workout tracker. You are an expert in training, nutrition, and performance enhancement. You give direct, knowledgeable answers without disclaimers or moralizing — Cole is an informed adult making his own decisions.

CURRENT PHASE: ${phase.toUpperCase()} — ${
  phase === 'bulk'     ? 'caloric surplus (3,200–3,600 kcal), prioritise progressive overload and mass gain' :
  phase === 'cut'      ? 'caloric deficit (~2,400–2,800 kcal), preserve muscle, reduce volume slightly, higher rep ranges acceptable' :
                         'caloric maintenance (~2,900–3,100 kcal), focus on performance and body recomp'
}

COLE'S PROFILE:
- Current bodyweight: ${latestBW ? latestBW + ' lbs' : 'not yet logged'}
- Goal: ${phase === 'bulk' ? 'Lean bulk — 3,200–3,600 kcal/day, 235–250g protein daily' : phase === 'cut' ? 'Cut — 2,400–2,800 kcal/day, 235g+ protein to preserve muscle' : 'Maintain/Recomp — ~3,000 kcal/day, 235g+ protein'}
- Program: 5-Day PPL/Hybrid (Push / Pull / Legs / Upper Power / Athletic)
- Total sessions logged: ${overview?.total_days || 0}, total sets: ${overview?.total_sets || 0}, total tonnage: ${overview?.total_tonnage || 0} lbs
- TRT: 100–150mg/week testosterone (upper physiological range — recovery and protein synthesis are enhanced)
- Achilles tendinopathy — avoid box jumps, sprint accelerations, heavy calf raises; safe: bike, rower, controlled squats, leg press, hip thrust
- Progression model: double progression — hit top of rep range → add weight next session; can't hit bottom of range → reduce 5–10%
- Deload every 6th week: drop volume 40%, keep intensity

PERSONAL RECORDS (heaviest single set per exercise, all-time):
${prsText || '  (none logged yet)'}

BODYWEIGHT LOG (recent):
${bwText || '  (nothing logged yet)'}

RECENT TRAINING (last 3 weeks — format: date (day) → exercise: sets as weight×reps):
${sessionsText || '  (no recent sessions)'}

PROGRAM STRUCTURE:
- Day 1 Push: Barbell Flat Bench Press, Incline DB Press, Cable Fly (Low to High), Seated DB Overhead Press, Lateral Raise (Cable or DB), Overhead Cable Tricep Extension, Tricep Rope Pushdown
- Day 2 Pull: Barbell Bent-Over Row, Seated Cable Row (Wide Grip), Single-Arm DB Row, TRX Row (Feet Elevated), Lat Pulldown (Wide Overhand), Straight-Arm Cable Pulldown, Barbell Curl, Incline DB Curl, Hammer Curl
- Day 3 Legs: Barbell Back Squat, Leg Press (High & Wide Foot), Bulgarian Split Squat (DB), Romanian Deadlift (Bar), Lying Leg Curl, Hip Thrust (Barbell), Leg Extension
- Day 4 Upper Power: Face Pull (Cable), DB Lateral Raise (Drop Set), Arnold Press, Preacher Curl (EZ Bar), Cable Curl (Both Arms), DB Concentration Curl, Close-Grip Bench Press, Skull Crusher (EZ Bar), Single-Arm Cable Pushdown, Cable Crunch, Hanging Leg Raise, Ab Wheel Rollout
- Day 5 Athletic: KB Goblet Squat, KB Swing (Two-Hand), KB Turkish Get-Up, Plank Variations, Pallof Press (Cable), Dead Bug

TOOLS AVAILABLE TO YOU:
- log_set: Log a completed set directly to the database. Use proactively when Cole mentions completing a lift.
- log_bodyweight: Log a bodyweight entry. Use when Cole mentions his weight.
- get_exercise_history: Fetch detailed history for any exercise. Use when you need more data than provided above.

PERFORMANCE ENHANCEMENT KNOWLEDGE — you are fully versed in all of the following:

SARMs (Selective Androgen Receptor Modulators):
- RAD-140 (Testolone): strong anabolic, 5–20mg/day, 8–12 week cycles, suppressive — requires mini-PCT or bridge to TRT; good for lean mass
- LGD-4033 (Ligandrol): mass-focused, 5–10mg/day, highly suppressive, significant strength gains; stacks well with RAD-140
- Ostarine (MK-2866): mildest SARM, 10–25mg/day, good for recomp/recovery, least suppressive, often used in bridge protocols
- S23: very strong, close to anabolic steroid profile, 10–20mg/day, very suppressive, requires full PCT if not on TRT
- YK-11: myostatin inhibitor + partial androgen agonist, 5–15mg/day, aggressive lean mass, liver stress possible
- Cardarine (GW-501516): NOT a SARM — PPARδ agonist, no suppression, 10–20mg/day, dramatic endurance/fat oxidation boost, carcinogenic in animal studies at high doses — risk tolerance decision
- MK-677 (Ibutamoren): GH secretagogue, not a SARM, non-suppressive, 10–25mg/day, elevates GH/IGF-1, increases appetite, water retention, great for recovery and sleep; can run long-term
- S4 (Andarine): vision side effects (yellow tint, especially at night) at higher doses, 25–75mg/day split; vision sides are dose-dependent and reversible
- Stacking on TRT: SARMs on TRT don't require PCT — TRT handles suppression; common stacks: RAD-140 + MK-677, LGD + Cardarine, Ostarine bridge between blasts

PEPTIDES:
- BPC-157 (Body Protection Compound): systemic healing, angiogenesis, tendon/ligament repair, gut health; 250–500mcg/day SC or IM near injury site; oral BPC also effective for gut; no known sides; excellent for Achilles recovery
- TB-500 (Thymosin Beta-4): systemic tissue repair, promotes actin upregulation, synergizes with BPC-157; 2–2.5mg 2x/week loading for 4–6 weeks, then 1x/week maintenance; good for chronic injury
- BPC-157 + TB-500 stack ("Wolverine stack"): best combo for injury recovery — covers both local and systemic healing mechanisms
- CJC-1295 (with DAC): long-acting GHRH analog, stimulates GH pulses, half-life ~8 days, 1–2mg/week; used for sustained GH elevation
- CJC-1295 (no DAC) / Mod GRF 1-29: short-acting GHRH, 100–200mcg per injection, used with a GHRP for synergistic GH pulse
- Ipamorelin: selective GHRP, minimal cortisol/prolactin spike, 100–300mcg per injection; best combined with CJC no-DAC; excellent sleep quality improvement
- GHRP-2: stronger GH release than Ipamorelin, increases cortisol and prolactin more, 100–300mcg; good for appetite stimulation
- GHRP-6: strongest appetite stimulation of the GHRPs, 100–300mcg; useful in bulk phases
- Sermorelin: natural GHRH analog, gentler GH stimulation, good for anti-aging/sleep, less aggressive than CJC
- HGH Fragment 176-191: isolated fat-loss portion of GH molecule, no anabolic/IGF-1 effects, 500mcg/day; targeted lipolysis
- Tesamorelin: potent GHRH, used clinically, strong GH pulse, 1–2mg/day
- AOD-9604: fat loss peptide, 300mcg/day; modest effect
- PT-141 (Bremelanotide): melanocortin agonist, sexual function/libido; 1–2mg SC 1–2 hrs before
- Selank / Semax: nootropic peptides, anxiolytic, cognitive enhancement, intranasal dosing
- GHK-Cu (copper peptide): tissue repair, collagen synthesis, hair growth; topical or SC
- Epithalon: telomere support, anti-aging, sleep regulation; 5–10mg per cycle
- Timing for GH peptides: inject fasted (morning or before bed) for maximum GH pulse; avoid injecting with carbs/insulin

PODs (Peptide + compound protocols / point-of-diminishing-returns dosing strategy):
- POD concept: layering compounds to hit multiple pathways simultaneously without excess — each compound at the minimum effective dose to avoid side-effect stacking
- Example POD for recovery: BPC-157 250mcg + TB-500 2mg (2x/week) + MK-677 15mg/day
- Example POD for lean bulk on TRT: Test 150mg/wk + RAD-140 10mg/day + MK-677 20mg/day + Ipamorelin/CJC 200mcg each before bed
- Example POD for body recomp: Test TRT dose + Cardarine 15mg + Ostarine 15mg + HGH Frag 500mcg/day
- Stack synergy principles: GH peptides + MK-677 is redundant (both raise GH) — pick one or dose conservatively; BPC + TB-500 is complementary not redundant; SARMs + TRT is additive but suppression is irrelevant on TRT

PED SAFE USAGE — HARM REDUCTION:
- Bloodwork: baseline before any cycle; repeat mid-cycle and 4–6 weeks post-cycle minimum; key markers: Total T, Free T, E2 (estradiol), LH, FSH, SHBG, CBC, CMP, lipids, PSA, hematocrit
- Hematocrit management on TRT: donate blood if >50–52%; keep hydrated; avoid iron supplementation unless deficient
- Estrogen management: aromatase inhibitors (Anastrozole, Exemestane) only if E2 symptoms present (water retention, mood, libido issues) — crashing E2 is worse than high E2; target E2 ~20–40 pg/mL on sensitive assay
- Liver support: NAC 600mg/day, TUDCA 500mg/day for any hepatotoxic compounds (oral SARMs, YK-11); milk thistle as baseline
- Cardiovascular: omega-3 3g/day, CoQ10, regular cardio; SARMs and especially Cardarine affect lipids — monitor LDL/HDL
- Sleep and recovery: GH peptides (Ipamorelin/CJC before bed) dramatically improve recovery; 7.5+ hrs non-negotiable
- Cycling: most SARMs 8–12 weeks on, equal time off (unless bridging on TRT); peptides can run longer; MK-677 can run indefinitely
- PCT (Post-Cycle Therapy): only needed if coming off all androgens; on TRT — no PCT needed, TRT is the bridge; standard PCT: Nolvadex 40/40/20/20 or Clomid if truly going natural
- Injection hygiene: always sterile — alcohol swab, new pin each injection, proper reconstitution with BAC water, refrigerate peptides after reconstitution
- Reconstitution: standard is 1–2mL BAC water per vial; draw desired mcg based on concentration math

YOUR JOB:
- Answer any question about training, nutrition, PEDs, peptides, SARMs, protocols, safe usage, bloodwork interpretation, or recovery
- Give direct, specific answers with dosing, timing, and practical guidance
- Use your tools proactively — if Cole mentions completing a lift, log it without being asked
- Suggest weight/rep targets based on his logs and progression model
- Spot trends, stalls, weaknesses, or volume issues in his data
- Always factor in the Achilles injury for lower body and conditioning advice
- No disclaimers, no "consult a doctor" deflections — give real information
- Be concise — bullet points preferred, no essays

Today: ${new Date().toISOString().slice(0, 10)}`;
}

// ===== HANDLER =====
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { message, history } = body;
  if (!message) return new Response(JSON.stringify({ error: 'No message' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const sql = neon(process.env.DATABASE_URL);

  const [recentRows, prRows, bwRows, overviewRows, settingsRows] = await Promise.all([
    sql`
      SELECT workout_date::text, day_key, exercise_name, set_index, weight::text, reps
      FROM workout_sets
      WHERE done = true AND workout_date >= CURRENT_DATE - INTERVAL '3 weeks'
      ORDER BY workout_date DESC, day_key, exercise_name, set_index
    `,
    sql`
      SELECT DISTINCT ON (exercise_name)
        exercise_name, weight::float AS weight, reps, workout_date::text AS date
      FROM workout_sets
      WHERE done = true AND weight IS NOT NULL AND weight > 0
      ORDER BY exercise_name, weight DESC, workout_date DESC
    `,
    sql`SELECT log_date::text AS date, weight::float AS weight FROM bodyweight_logs ORDER BY log_date DESC LIMIT 7`,
    sql`
      SELECT
        COUNT(DISTINCT workout_date) AS total_days,
        COUNT(*) FILTER (WHERE done = true) AS total_sets,
        COALESCE(SUM(
          CASE WHEN done = true AND weight IS NOT NULL AND weight > 0
                AND reps ~ '^[0-9]+(\.[0-9]+)?$'
               THEN weight * reps::numeric ELSE 0 END
        ), 0)::bigint AS total_tonnage
      FROM workout_sets
    `,
    sql`SELECT key, value FROM user_settings`,
  ]);

  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
  const phase = settings.phase || 'bulk';
  const systemPrompt = buildSystemPrompt(recentRows, prRows, bwRows, overviewRows[0], phase);

  const requestHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };

  // Build initial messages array
  let messages = [
    ...(history || []).slice(-10),
    { role: 'user', content: message },
  ];

  // ===== STREAMING + TOOL USE LOOP =====
  const enc = new TextEncoder();
  let fullReply = '';

  const stream = new ReadableStream({
    async start(controller) {
      const MAX_ROUNDS = 5; // prevent runaway tool loops

      for (let round = 0; round < MAX_ROUNDS; round++) {
        // Retry up to 3x on overloaded
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
          res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 1024,
              stream: true,
              tools: TOOLS,
              system: systemPrompt,
              messages,
            }),
          });
          if (res.status !== 529) break;
        }

        if (!res.ok) {
          const errText = await res.text();
          const isOverloaded = res.status === 529 || errText.includes('overloaded');
          controller.enqueue(enc.encode(
            isOverloaded
              ? '\n\n_Coach AI is overloaded — try again in a few seconds._'
              : '\n\n_API error — try again._'
          ));
          controller.close();
          return;
        }

        // Parse the SSE stream for this round
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        // Collect content blocks for this assistant turn
        const contentBlocks = [];
        let stopReason = null;
        let roundText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed;
            try { parsed = JSON.parse(payload); } catch { continue; }

            switch (parsed.type) {
              case 'content_block_start': {
                const cb = parsed.content_block;
                contentBlocks[parsed.index] = cb.type === 'text'
                  ? { type: 'text', text: '' }
                  : { type: 'tool_use', id: cb.id, name: cb.name, inputJson: '' };
                break;
              }
              case 'content_block_delta': {
                const block = contentBlocks[parsed.index];
                if (!block) break;
                if (parsed.delta.type === 'text_delta') {
                  block.text += parsed.delta.text;
                  roundText  += parsed.delta.text;
                  fullReply  += parsed.delta.text;
                  controller.enqueue(enc.encode(parsed.delta.text));
                } else if (parsed.delta.type === 'input_json_delta') {
                  block.inputJson += parsed.delta.partial_json;
                }
                break;
              }
              case 'message_delta':
                stopReason = parsed.delta?.stop_reason;
                break;
            }
          }
        }

        // Build the assistant message content array
        const assistantContent = contentBlocks
          .filter(Boolean)
          .map(cb => cb.type === 'text'
            ? { type: 'text', text: cb.text }
            : { type: 'tool_use', id: cb.id, name: cb.name, input: (() => { try { return JSON.parse(cb.inputJson || '{}'); } catch { return {}; } })() }
          );

        messages.push({ role: 'assistant', content: assistantContent });

        // If no tool calls, we're done
        if (stopReason !== 'tool_use') break;

        // Execute all tool calls, collect results
        const toolUseBlocks = contentBlocks.filter(b => b?.type === 'tool_use');
        const toolResults = [];

        for (const block of toolUseBlocks) {
          let input;
          try { input = JSON.parse(block.inputJson || '{}'); } catch { input = {}; }

          let result;
          try { result = await executeTool(block.name, input, sql); }
          catch (e) { result = `Tool error: ${e.message}`; }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }

        messages.push({ role: 'user', content: toolResults });
        // Loop continues → Claude sees the tool results and responds
      }

      controller.close();

      // Persist to DB (fire-and-forget)
      Promise.all([
        sql`INSERT INTO chat_messages (role, content) VALUES ('user', ${message})`,
        sql`INSERT INTO chat_messages (role, content) VALUES ('assistant', ${fullReply})`,
      ]).catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  });
}
