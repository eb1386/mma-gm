import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BUILDS, BUILD_LIST } from '@core/config/builds';
import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '@core/config/divisions';
import { NAME_BANKS } from '@core/data/names';
import { loadSnapshot, loadSnapshotIndex, type SnapshotFile, type SnapshotIndexEntry } from '@core/data/snapshot';
import { ovrDisplayed, RATING_KEYS, RATING_LONG_LABEL, type Ratings } from '@core/types/fighter';
import { formatHeight } from '@core/types/common';
import { GAME_NAME } from '@core/config/branding';
import type { Difficulty, GameMode } from '@core/types/common';
import { CREATION_PRESETS } from '@core/world/generator';
import { CREATION_PHASES } from '@core/world/newgame';
import { buildCreatedFighter, CareerCreationCanceled, createNewGame, validateAllocation, type CreationProgress } from '@core/world/newgame';
import { saveGame } from '@core/save/store';
import { useGame } from '../store';
import { DataTable, Notice, Panel, Rating, RealTag, OctagonMark } from '../components';

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
  const [index, setIndex] = useState<SnapshotIndexEntry[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CreationProgress | null>(null);
  const cancelRef = useState<{ canceled: boolean }>({ canceled: false })[0];

  const [mode, setMode] = useState<GameMode>('fighter');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [saveName, setSaveName] = useState('New career');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [fillRoster, setFillRoster] = useState(true);

  const [fighterSource, setFighterSource] = useState<'real' | 'created'>('real');
  const [selectedFighterId, setSelectedFighterId] = useState<string | null>(null);
  const [divisionFilter, setDivisionFilter] = useState<DivisionId | 'all'>('all');

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
      .sort((a, b) => ovrDisplayed(b.ratings) - ovrDisplayed(a.ratings));
  }, [snapshot, divisionFilter]);

  const canStart =
    Boolean(snapshot) &&
    !busy &&
    (mode === 'spectator' ||
      (mode === 'coach' && (coachStart === 'new' ? gymName.trim().length > 1 : existingGymId !== '')) ||
      (mode === 'fighter' &&
        (fighterSource === 'real' ? Boolean(selectedFighterId) : validation.ok && firstName.trim() !== '' && lastName.trim() !== '')));

  const start = async () => {
    if (!snapshot) return;
    cancelRef.canceled = false;
    setBusy(true);
    setProgress({ phase: 'Loading snapshot', index: 0, total: 9 });
    // Yield a frame so the first phase paints before the work begins.
    await new Promise((r) => setTimeout(r, 16));
    try {
      const created =
        mode === 'fighter' && fighterSource === 'created'
          ? buildCreatedFighter(
              {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                nickname: nickname.trim() || null,
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

      const { save } = createNewGame(snapshot, {
        onProgress: (p) => setProgress(p),
        shouldCancel: () => cancelRef.canceled,
        saveName: saveName.trim() || 'New career',
        seed,
        mode,
        settings: { difficulty, fillRosterWithGenerated: fillRoster },
        playerFighterId: mode === 'fighter' && fighterSource === 'real' ? selectedFighterId ?? undefined : undefined,
        createdFighter: created,
        coach:
          mode === 'coach'
            ? coachStart === 'new'
              ? { name: coachName, newGym: { name: gymName.trim(), country: gymCountry, city: gymCity.trim() || 'Unknown' } }
              : { name: coachName, gymId: existingGymId }
            : undefined,
      });
      await saveGame(save);
      setSave(save);
      navigate('/dashboard');
    } catch (e) {
      if (e instanceof CareerCreationCanceled) setError('Career creation canceled. Nothing was saved.');
      else setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="splash">
      <h1>
        <OctagonMark size={26} /> {GAME_NAME}
      </h1>
      <p className="lede">
        A text based MMA career and coaching simulation. Real ranked roster, deterministic fight engine, decades of world
        history.
      </p>

      {error && <Notice kind="bad">{error}</Notice>}

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
                <span className="dim small">
                  Every champion plus the officially ranked one through fifteen in each of the eight men's divisions.
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
                  { key: 'ovr', label: 'Ovr', numeric: true, sort: (f) => ovrDisplayed(f.ratings), render: (f) => <Rating value={ovrDisplayed(f.ratings)} /> },
                  { key: 'pot', label: 'Pot', numeric: true, sort: (f) => f.pot, render: (f) => <Rating value={f.pot} /> },
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
                      <input type="number" value={age} min={18} max={44} onChange={(e) => setAge(Number(e.target.value))} />
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
                      <input type="number" value={heightIn} min={58} max={84} onChange={(e) => setHeightIn(Number(e.target.value))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Reach in inches</label>
                      <input type="number" value={reachIn} min={58} max={90} onChange={(e) => setReachIn(Number(e.target.value))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Walking weight</label>
                      <input
                        type="number"
                        value={walkingWeightLb}
                        min={110}
                        max={300}
                        onChange={(e) => setWalkingWeightLb(Number(e.target.value))}
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
            <input type="text" value={coachName} onChange={(e) => setCoachName(e.target.value)} />
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
                {(snapshot?.gyms ?? [])
                  .slice()
                  .sort((a, b) => b.fighterIds.length - a.fighterIds.length)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.fighterIds.length} ranked fighters, {g.city})
                    </option>
                  ))}
              </select>
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

      {busy && progress && (
        <Panel title="Building the world">
          <div className="mb">
            <strong>{progress.phase}</strong>
            {progress.detail ? <span className="dim small"> · {progress.detail}</span> : null}
          </div>
          <div className="bar" style={{ height: 6 }}>
            <span style={{ width: `${Math.round(((progress.index + 1) / progress.total) * 100)}%` }} />
          </div>
          <ol className="small dim mt" style={{ paddingLeft: 18, margin: 0 }}>
            {CREATION_PHASES.map((p, i) => (
              <li key={p} style={{ color: i < progress.index ? 'var(--good)' : i === progress.index ? 'var(--text)' : undefined }}>
                {p}
                {i < progress.index ? ' done' : ''}
              </li>
            ))}
          </ol>
          <p className="small faint mt">
            Building a world runs in one pass and takes a few seconds. It cannot be interrupted part
            way through, so there is nothing to cancel: nothing is written until it finishes.
          </p>
        </Panel>
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
