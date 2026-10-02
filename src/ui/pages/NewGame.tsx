import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BUILDS, BUILD_LIST } from '@core/config/builds';
import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '@core/config/divisions';
import { NAME_BANKS } from '@core/data/names';
import { loadSnapshot, loadSnapshotIndex, type SnapshotFile, type SnapshotIndexEntry } from '@core/data/snapshot';
import { ovrDisplayed, RATING_KEYS, RATING_LONG_LABEL, type Ratings } from '@core/types/fighter';
import { formatHeight } from '@core/types/common';
import { GAME_NAME, PROMOTION_NAME } from '@core/config/branding';
import { MAIN_START_NEWCOMER_FLOOR } from '@core/world/debut';
import { MIN_REGIONAL_START_AGE, PRO_AGE, promotionsForCountry, REGIONAL_LEVELS, REGIONAL_PROMOTION_BY_ID } from '@core/config/regional';
import { bankForCountry } from '@core/data/names';
import type { Difficulty, GameMode } from '@core/types/common';
import { CREATION_PRESETS } from '@core/world/generator';
import { buildCreatedFighter, createNewGame, presetAgeBounds, validateAllocation } from '@core/world/newgame';
import { saveGame } from '@core/save/store';
import { cleanNickname } from '@core/data/real-fighter';
import { useGame } from '../store';
import { nameMatches } from '../search';
import { DataTable, Notice, Panel, Rating, RealTag, OctagonMark } from '../components';

/** Gyms with fewer roster fighters than this are listed only on request. */
const MIN_LISTED_GYM_FIGHTERS = 2;

const MODES: { key: GameMode; label: string; blurb: string }[] = [
  {
    key: 'fighter',
    label: 'Play as a fighter',
    blurb: 'Take an existing ranked fighter or create your own. You choose fights, camps, game plans and contracts.',
  },
  {
    key: 'coach',
    label: 'Coach mode',
    blurb: 'Run a gym. You advise rather than command: fighters can refuse your plan, take fights you dislike, and leave.',
  },
  {
    key: 'spectator',
    label: 'Spectator',
    blurb: 'Control nobody. Create a world and watch decades of it unfold.',
  },
];

export function NewGamePage() {
  const navigate = useNavigate();
  const setSave = useGame((s) => s.setSave);
  // This screen has no career chrome, so a player who opened it from a loaded career needs a
  // visible way back that does not start a new world.
  const hasCareer = useGame((s) => s.save !== null);
  const [index, setIndex] = useState<SnapshotIndexEntry[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The busy panel and the error both sit far from the Start button on a phone, so each is
  // scrolled into view when it appears.
  const busyRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const [mode, setMode] = useState<GameMode>('fighter');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [saveName, setSaveName] = useState('New career');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [fillRoster, setFillRoster] = useState(true);

  const [fighterSource, setFighterSource] = useState<'real' | 'created'>('real');
  const [selectedFighterId, setSelectedFighterId] = useState<string | null>(null);
  const [divisionFilter, setDivisionFilter] = useState<DivisionId | 'all'>('all');
  const [nameFilter, setNameFilter] = useState('');

  // Created fighter fields.
  const [presetKey, setPresetKey] = useState('balanced-prospect');
  const preset = CREATION_PRESETS.find((p) => p.key === presetKey)!;
  const [firstName, setFirstName] = useState('Alex');
  const [lastName, setLastName] = useState('Vance');
  const [nickname, setNickname] = useState('');
  const [country, setCountry] = useState('United States');
  const [hometown, setHometown] = useState('');
  const [age, setAge] = useState(24);
  const [divisionId, setDivisionId] = useState<DivisionId>('lightweight');
  const [build, setBuild] = useState<keyof typeof BUILDS>('balanced');
  const [heightIn, setHeightIn] = useState(70);
  const [reachIn, setReachIn] = useState(72);
  const [walkingWeightLb, setWalkingWeightLb] = useState(176);
  const [stance, setStance] = useState<'orthodox' | 'southpaw' | 'switch'>('orthodox');
  // Where a created career begins: signed to the main promotion, or on a regional promotion
  // working toward the call up. Players asked to be able to start young and earn their way in.
  const [careerStart, setCareerStart] = useState<'main' | 'regional'>('main');
  const regionalChoices = useMemo(() => promotionsForCountry(country, bankForCountry(country)?.region ?? null), [country]);
  const [regionalId, setRegionalId] = useState<string>('');
  const regionalPromotion = REGIONAL_PROMOTION_BY_ID[regionalId] ?? regionalChoices[0];
  // The preset decides the age range as well as the budget, from the same bounds the core clamps to,
  // so the form refuses an age rather than the career quietly starting at a different one.
  const [presetMinAge, presetMaxAge] = presetAgeBounds(preset);
  const startMinAge = careerStart === 'regional' ? MIN_REGIONAL_START_AGE : PRO_AGE;
  const minAge = Math.max(startMinAge, presetMinAge);
  const maxAge = presetMaxAge;
  const ageValid = Number.isFinite(age) && age >= minAge && age <= maxAge;
  const physicalsValid = [heightIn, reachIn, walkingWeightLb].every((v) => Number.isFinite(v) && v > 0);
  // The same walking weight bounds the core clamps to. Clamping silently turned a typed 300 lb
  // flyweight into 170 with no word to the player.
  const weightDivision = DIVISION_BY_ID[divisionId];
  const minWalkLb = weightDivision.floorLb;
  const maxWalkLb = weightDivision.limitLb + 45;
  const walkingWeightValid = !Number.isFinite(walkingWeightLb) || (walkingWeightLb >= minWalkLb && walkingWeightLb <= maxWalkLb);
  const [allocation, setAllocation] = useState<Ratings>({
    striking: 57,
    grappling: 57,
    wrestling: 57,
    submissions: 57,
    cardio: 57,
    durability: 57,
  });

  const [coachName, setCoachName] = useState('Coach Reyes');
  const [gymName, setGymName] = useState('Vanguard Fight Team');
  const [gymCountry, setGymCountry] = useState('United States');
  const [gymCity, setGymCity] = useState('Denver');
  const [coachStart, setCoachStart] = useState<'new' | 'existing'>('new');
  const [existingGymId, setExistingGymId] = useState<string>('');
  const [showAllGyms, setShowAllGyms] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const idx = await loadSnapshotIndex();
        setIndex(idx.snapshots);
        const latest = idx.snapshots.find((s) => s.isLatest) ?? idx.snapshots[0];
        if (latest) setSnapshot(await loadSnapshot(latest.file));
      } catch (e) {
        setError(
          `Could not load the roster snapshot. Build it first with "npx vite-node tools/build-snapshot.ts". ${(e as Error).message}`
        );
      }
    })();
  }, []);

  // Keep the created fighter's physicals consistent with division and build.
  useEffect(() => {
    const d = DIVISION_BY_ID[divisionId];
    const b = BUILDS[build];
    setHeightIn(Math.round(d.priors.heightIn.mean + b.heightOffset));
    setReachIn(Math.round(d.priors.heightIn.mean + b.heightOffset + b.reachOverHeight));
    setWalkingWeightLb(Math.round(d.limitLb + d.typicalWalkAroundOverLb + b.walkAroundOffset));
  }, [divisionId, build]);

  useEffect(() => {
    const even = Math.floor(preset.points / 6);
    setAllocation({
      striking: even,
      grappling: even,
      wrestling: even,
      submissions: even,
      cardio: even,
      durability: even,
    });
    setAge(Math.round((preset.ageRange[0] + preset.ageRange[1]) / 2));
  }, [presetKey, preset.points, preset.ageRange]);

  const validation = validateAllocation(allocation, preset.points);
  const createdOvr = ovrDisplayed(allocation);

  const realFighters = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.fighters
      .filter((f) => divisionFilter === 'all' || f.divisionId === divisionFilter)
      .filter((f) => nameMatches(f.name, nameFilter))
      .sort((a, b) => ovrDisplayed(b.ratings) - ovrDisplayed(a.ratings));
  }, [snapshot, divisionFilter, nameFilter]);

  const canStart =
    Boolean(snapshot) &&
    !busy &&
    (mode === 'spectator' ||
      (mode === 'coach' && (coachStart === 'new' ? gymName.trim().length > 1 : existingGymId !== '')) ||
      (mode === 'fighter' &&
        (fighterSource === 'real'
          ? Boolean(selectedFighterId)
          : validation.ok && ageValid && physicalsValid && walkingWeightValid && firstName.trim() !== '' && lastName.trim() !== '')));

  const start = async () => {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    // Yield a frame so the busy state paints before the work begins. Building the world is one
    // synchronous pass, so nothing paints again until it is done: the panel used to list nine
    // phases and only ever showed the first of them.
    await new Promise((r) => setTimeout(r, 16));
    busyRef.current?.scrollIntoView({ block: 'nearest' });
    await new Promise((r) => setTimeout(r, 16));
    try {
      const created =
        mode === 'fighter' && fighterSource === 'created'
          ? buildCreatedFighter(
              {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                // Players tend to type the quotes themselves, and the interface adds its own.
                nickname: cleanNickname(nickname.trim()),
                country,
                hometown: hometown.trim() || null,
                age,
                heightIn,
                walkingWeightLb,
                divisionId,
                build,
                reachIn,
                stance,
                gymId: null,
                presetKey,
                allocation,
                startingRecord: preset.startingRecord,
              },
              seed,
              snapshot.meta.snapshotDate
            )
          : undefined;

      // A blank coach name keeps the head coach's generated name; spaces alone count as blank.
      const coachNameTrimmed = coachName.trim();
      const { save } = createNewGame(snapshot, {
        saveName: saveName.trim() || 'New career',
        seed,
        mode,
        settings: { difficulty, fillRosterWithGenerated: fillRoster },
        playerFighterId: mode === 'fighter' && fighterSource === 'real' ? selectedFighterId ?? undefined : undefined,
        createdFighter: created,
        regionalPromotionId: created && careerStart === 'regional' ? regionalPromotion?.id : undefined,
        coach:
          mode === 'coach'
            ? coachStart === 'new'
              ? { name: coachNameTrimmed, newGym: { name: gymName.trim(), country: gymCountry, city: gymCity.trim() || 'Unknown' } }
              : { name: coachNameTrimmed, gymId: existingGymId }
            : undefined,
      });
      await saveGame(save);
      setSave(save);
      navigate('/dashboard');
    } catch (e) {
      setError((e as Error).message);
      // The error renders at the top of a long page, out of sight of the button that caused it.
      setTimeout(() => errorRef.current?.scrollIntoView({ block: 'center' }), 0);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="splash">
      {hasCareer && (
        <p className="small">
          <Link to="/home">Back to your careers</Link>
        </p>
      )}
      <h1>
        <OctagonMark size={26} /> {GAME_NAME}
      </h1>
      <p className="lede">
        A text based MMA career and coaching simulation. Real ranked roster, deterministic fight engine, decades of world
        history.
      </p>

      {error && (
        <div ref={errorRef}>
          <Notice kind="bad">{error}</Notice>
        </div>
      )}

      <Panel title="Snapshot">
        {snapshot ? (
          <>
            <div className="row">
              <select
                value={snapshot.meta.snapshotId}
                onChange={async (e) => {
                  const entry = index.find((s) => s.snapshotId === e.target.value);
                  if (entry) setSnapshot(await loadSnapshot(entry.file));
                }}
              >
                {index.map((s) => (
                  <option key={s.snapshotId} value={s.snapshotId}>
                    {s.label} ({s.fighterCount} fighters)
                  </option>
                ))}
              </select>
              <span className="dim small">Captured {snapshot.meta.snapshotDate}</span>
            </div>
            <p className="small dim mt">{snapshot.meta.note}</p>
          </>
        ) : (
          <p className="dim">Loading snapshot.</p>
        )}
      </Panel>

      <Panel title="Mode">
        <div className="grid c3">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={mode === m.key ? 'primary' : ''}
              style={{ textAlign: 'left', padding: '8px 10px', whiteSpace: 'normal', height: '100%' }}
              onClick={() => setMode(m.key)}
            >
              <strong style={{ display: 'block', marginBottom: 3 }}>{m.label}</strong>
              <span className="small" style={{ opacity: 0.85 }}>
                {m.blurb}
              </span>
            </button>
          ))}
        </div>
      </Panel>

      {mode === 'fighter' && (
        <Panel
          title="Fighter"
          actions={
            <span className="row tight">
              <button className={fighterSource === 'real' ? 'primary small' : 'small'} onClick={() => setFighterSource('real')}>
                Real fighter
              </button>
              <button className={fighterSource === 'created' ? 'primary small' : 'small'} onClick={() => setFighterSource('created')}>
                Create a fighter
              </button>
            </span>
          }
          flush
        >
          {fighterSource === 'real' ? (
            <>
              <div className="row" style={{ padding: 8 }}>
                <label>Division</label>
                <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value as DivisionId | 'all')}>
                  <option value="all">All divisions</option>
                  {DIVISIONS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  placeholder="Search by name"
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                  style={{ flex: '1 1 160px', minWidth: 0 }}
                />
                <span className="dim small">
                  {realFighters.length} real fighters: every champion, the official rankings and the roster from recent official
                  fight cards.
                </span>
              </div>
              <DataTable
                rows={realFighters}
                maxHeight={340}
                rowKey={(f) => f.id}
                rowClass={(f) => (f.id === selectedFighterId ? 'highlight' : undefined)}
                initialSort="ovr"
                columns={[
                  {
                    key: 'pick',
                    label: '',
                    render: (f) => (
                      <button className="small" onClick={() => setSelectedFighterId(f.id)}>
                        {f.id === selectedFighterId ? 'Selected' : 'Select'}
                      </button>
                    ),
                  },
                  { key: 'name', label: 'Fighter', sort: (f) => f.name, render: (f) => <strong>{f.name}</strong> },
                  // Ovr and Pot decide the pick, so they sit right after the name. Behind division, rank and
                  // record they started past the right edge of a phone.
                  { key: 'ovr', label: 'Ovr', numeric: true, sort: (f) => ovrDisplayed(f.ratings), render: (f) => <Rating value={ovrDisplayed(f.ratings)} /> },
                  { key: 'pot', label: 'Pot', numeric: true, sort: (f) => f.pot, render: (f) => <Rating value={f.pot} /> },
                  {
                    key: 'div',
                    label: 'Division',
                    sort: (f) => DIVISION_BY_ID[f.divisionId].order,
                    render: (f) => DIVISION_BY_ID[f.divisionId].shortName,
                  },
                  {
                    key: 'rank',
                    label: 'Rank',
                    numeric: true,
                    sort: (f) => (f.isChampion ? 0 : (f.ranking ?? 99)),
                    render: (f) => (f.isChampion ? <span className="tag champ">C</span> : (f.ranking ?? '-')),
                  },
                  {
                    key: 'record',
                    label: 'Record',
                    render: (f) => `${f.record.wins}-${f.record.losses}${f.record.draws ? `-${f.record.draws}` : ''}`,
                  },
                  { key: 'age', label: 'Age', numeric: true, sort: (f) => f.ageAtSnapshot ?? 0, render: (f) => f.ageAtSnapshot ?? '?' },
                  { key: 'lng', label: 'Lng', numeric: true, sort: (f) => f.longevity, render: (f) => <Rating value={f.longevity} /> },
                  { key: 'src', label: 'Source', render: (f) => <RealTag fighter={f} /> },
                ]}
              />
            </>
          ) : (
            <div style={{ padding: 9 }}>
              <div className="grid c2">
                <div>
                  <div className="field">
                    <label>Preset</label>
                    <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
                      {CREATION_PRESETS.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <span className="small dim">{preset.description}</span>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label>First name</label>
                      <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Last name</label>
                      <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                    </div>
                  </div>
                  <div className="field">
                    <label>Nickname, optional</label>
                    <input type="text" value={nickname} onChange={(e) => setNickname(e.target.value)} />
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label>Country</label>
                      <select value={country} onChange={(e) => setCountry(e.target.value)}>
                        {NAME_BANKS.map((b) => (
                          <option key={b.code} value={b.country}>
                            {b.country}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Hometown, optional</label>
                      <input type="text" value={hometown} onChange={(e) => setHometown(e.target.value)} />
                    </div>
                  </div>
                  <p className="small faint">
                    Country never grants a skill or physical bonus. It affects naming, home market popularity, travel
                    distance and which regional gyms are nearby.
                  </p>
                </div>

                <div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label>Division</label>
                      <select value={divisionId} onChange={(e) => setDivisionId(e.target.value as DivisionId)}>
                        {DIVISIONS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.limitLb} lb)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ width: 90 }}>
                      <label>Age</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={Number.isFinite(age) ? age : ''}
                        min={minAge}
                        max={maxAge}
                        onChange={(e) => setAge(e.target.value === '' ? NaN : Number(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Build</label>
                    <select value={build} onChange={(e) => setBuild(e.target.value as keyof typeof BUILDS)}>
                      {BUILD_LIST.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                    <span className="small dim">{BUILDS[build].description}</span>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label>Height ({formatHeight(heightIn)})</label>
                      <input type="number" value={Number.isFinite(heightIn) ? heightIn : ''} min={58} max={84} onChange={(e) => setHeightIn(e.target.value === '' ? NaN : Number(e.target.value))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Reach in inches</label>
                      <input type="number" value={Number.isFinite(reachIn) ? reachIn : ''} min={58} max={90} onChange={(e) => setReachIn(e.target.value === '' ? NaN : Number(e.target.value))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Walking weight</label>
                      <input
                        type="number"
                        value={Number.isFinite(walkingWeightLb) ? walkingWeightLb : ''}
                        min={minWalkLb}
                        max={maxWalkLb}
                        onChange={(e) => setWalkingWeightLb(e.target.value === '' ? NaN : Number(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Stance</label>
                    <select value={stance} onChange={(e) => setStance(e.target.value as typeof stance)}>
                      <option value="orthodox">Orthodox</option>
                      <option value="southpaw">Southpaw</option>
                      <option value="switch">Switch</option>
                    </select>
                  </div>
                </div>
              </div>

              <h3 className="mt">Career start</h3>
              <div className="row tight mb">
                <button className={careerStart === 'main' ? 'primary small' : 'small'} onClick={() => setCareerStart('main')}>
                  Signed to {PROMOTION_NAME}
                </button>
                <button className={careerStart === 'regional' ? 'primary small' : 'small'} onClick={() => setCareerStart('regional')}>
                  Regional circuit
                </button>
              </div>
              {careerStart === 'regional' ? (
                <div className="field">
                  <label>Regional promotion</label>
                  <select value={regionalPromotion?.id ?? ''} onChange={(e) => setRegionalId(e.target.value)}>
                    {regionalChoices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.abbreviation}), {p.country}, {REGIONAL_LEVELS[p.level].label.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  {regionalPromotion && <span className="small dim">{regionalPromotion.blurb}</span>}
                  <p className="small faint">
                    Fight on regional cards, climb the {regionalPromotion?.abbreviation} rankings and win the belt. {PROMOTION_NAME}{' '}
                    calls up fighters on their record, their regional standing and their ability, and sometimes invites them to a
                    Proving Ground tryout first. Start as young as {MIN_REGIONAL_START_AGE}: bouts before {PRO_AGE} are amateur, and the
                    starting record becomes the amateur record.
                  </p>
                </div>
              ) : (
                <p className="small faint">The career starts on the {PROMOTION_NAME} roster with a four fight deal, from {PRO_AGE}.</p>
              )}
              {careerStart === 'main' && fighterSource === 'created' && createdOvr < MAIN_START_NEWCOMER_FLOOR && (
                <p className="small warn">
                  At Ovr {createdOvr} this fighter is below even the newest names on the {PROMOTION_NAME} roster, who start
                  at about Ovr {MAIN_START_NEWCOMER_FLOOR}. The regional circuit is the better start: it builds the fighter up
                  against their own level before the call up.
                </p>
              )}
              {!ageValid && (
                <p className="small bad">
                  Age must be {minAge} to {maxAge} for a {preset.label.toLowerCase()}
                  {careerStart === 'main' && presetMinAge < PRO_AGE ? '. Start on the regional circuit to begin younger' : ''}.
                </p>
              )}
              {!physicalsValid && <p className="small bad">Height, reach and walking weight all need a value.</p>}
              {!walkingWeightValid && (
                <p className="small bad">
                  Walking weight must be {minWalkLb} to {maxWalkLb} lb for {weightDivision.name}.
                </p>
              )}

              <h3 className="mt">Rating allocation</h3>
              <p className="small dim">
                Budget {preset.points} points across the six ratings. Ovr is the plain mean of the six and is never
                weighted. {validation.message}
              </p>
              {RATING_KEYS.map((k) => (
                <div className="allocation-row" key={k}>
                  <label>{RATING_LONG_LABEL[k]}</label>
                  <input
                    type="range"
                    min={15}
                    max={90}
                    value={allocation[k]}
                    onChange={(e) => setAllocation({ ...allocation, [k]: Number(e.target.value) })}
                  />
                  <span className="num mono">{allocation[k]}</span>
                  <Rating value={allocation[k]} />
                </div>
              ))}
              <div className="row mt">
                <strong>Ovr {createdOvr}</strong>
                <span className={validation.ok ? 'dim' : 'bad'}>
                  {validation.used} of {preset.points} points used
                </span>
              </div>
            </div>
          )}
        </Panel>
      )}

      {mode === 'coach' && (
        <Panel title="Gym">
          <div className="row mb">
            <button className={coachStart === 'new' ? 'primary small' : 'small'} onClick={() => setCoachStart('new')}>
              Found a new gym
            </button>
            <button className={coachStart === 'existing' ? 'primary small' : 'small'} onClick={() => setCoachStart('existing')}>
              Take over an existing gym
            </button>
          </div>
          <div className="field">
            <label>Your name</label>
            <input
              type="text"
              value={coachName}
              placeholder="Leave blank for a generated name"
              onChange={(e) => setCoachName(e.target.value)}
            />
          </div>
          {coachStart === 'new' ? (
            <div className="row">
              <div className="field" style={{ flex: 2 }}>
                <label>Gym name</label>
                <input type="text" value={gymName} onChange={(e) => setGymName(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Country</label>
                <select value={gymCountry} onChange={(e) => setGymCountry(e.target.value)}>
                  {NAME_BANKS.map((b) => (
                    <option key={b.code} value={b.country}>
                      {b.country}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>City</label>
                <input type="text" value={gymCity} onChange={(e) => setGymCity(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="field">
              <label>Gym</label>
              <select value={existingGymId} onChange={(e) => setExistingGymId(e.target.value)}>
                <option value="">Choose a gym</option>
                {/* Most sourced gyms are named by a single fighter, so the list starts with the real teams.
                    The count is every roster fighter at the gym, ranked or not, and the city is shown only
                    when the gym's own name gives one. */}
                {(snapshot?.gyms ?? [])
                  .filter((g) => showAllGyms || g.fighterIds.length >= MIN_LISTED_GYM_FIGHTERS || g.id === existingGymId)
                  .sort((a, b) => b.fighterIds.length - a.fighterIds.length)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.fighterIds.length} fighter{g.fighterIds.length === 1 ? '' : 's'}
                      {g.city && g.city !== 'Unknown' ? `, ${g.city}` : ''})
                    </option>
                  ))}
              </select>
              <label className="row tight">
                <input type="checkbox" checked={showAllGyms} onChange={(e) => setShowAllGyms(e.target.checked)} />
                <span className="small">Show every gym</span>
              </label>
              <span className="small dim">
                Gym names come from the sourced training affiliation on official athlete profiles. Every other gym
                attribute is a simulated game value.
              </span>
            </div>
          )}
        </Panel>
      )}

      <Panel title="World settings">
        <div className="grid c4">
          <div className="field">
            <label>Save name</label>
            <input type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          </div>
          <div className="field">
            <label>Difficulty</label>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
              <option value="easy">Easy</option>
              <option value="normal">Normal</option>
              <option value="hard">Hard</option>
              <option value="brutal">Brutal</option>
            </select>
          </div>
          <div className="field">
            <label>Random seed</label>
            <div className="row tight">
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} style={{ width: 120 }} />
              <button className="small" onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}>
                New
              </button>
            </div>
          </div>
          <div className="field">
            <label>Roster depth</label>
            <label className="row tight">
              <input type="checkbox" checked={fillRoster} onChange={(e) => setFillRoster(e.target.checked)} />
              <span className="small">Fill unranked depth with fictional fighters</span>
            </label>
          </div>
        </div>
        <p className="small faint">
          The same seed with the same decisions produces the same world every time.
        </p>
      </Panel>

      {busy && (
        <div ref={busyRef}>
          <Panel title="Building the world">
            <p className="mb" role="status">
              <strong>Building the world. This takes a few seconds.</strong>
            </p>
            <div className="bar indeterminate" style={{ height: 6, maxWidth: 'none' }}>
              <span />
            </div>
            <p className="small faint mt">Nothing is written until it finishes.</p>
          </Panel>
        </div>
      )}

      <div className="row">
        <button className="primary" disabled={!canStart} onClick={() => void start()}>
          {busy ? 'Building the world' : 'Start career'}
        </button>
        <button onClick={() => navigate('/load')}>Load a save</button>
      </div>
    </div>
  );
}
