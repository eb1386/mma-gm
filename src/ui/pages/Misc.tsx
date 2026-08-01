import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DIVISIONS } from '@core/config/divisions';
import { formatDate } from '@core/types/common';
import { hallOfFameScore } from '@core/world/history';
import { deleteSave, downloadSave, estimateSaveSize, importSaveFromFile, listSaves, loadGame } from '@core/save/store';
import type { SaveIndexEntry } from '@core/types/save';
import { migrationNotes } from '@core/save/migrate';
import { useGame, discardPendingSave } from '../store';
import { DataTable, KeyValues, Notice, Panel, Rating } from '../components';

// ---------------------------------------------------------------------------

export function HallOfFamePage() {
  const save = useGame((s) => s.save)!;
  const inducted = save.history.hallOfFame;
  const candidates = Object.values(save.fighters)
    .filter((f) => f.retired && f.hallOfFameYear === null)
    .map((f) => ({ f, score: hallOfFameScore(save, f) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Hall of Fame</h1>
        <span className="sub">{inducted.length} inducted</span>
      </div>

      <Panel title="Inducted" flush>
        <table>
          <thead>
            <tr>
              <th className="num">Year</th>
              <th>Fighter</th>
              <th className="num">Vote</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {inducted
              .slice()
              .reverse()
              .map((e, i) => (
                <tr key={i}>
                  <td className="num">{e.year}</td>
                  <td>
                    <Link to={`/fighter/${e.fighterId}`}>{save.fighters[e.fighterId]?.name ?? 'Unknown'}</Link>
                  </td>
                  <td className="num">{e.votePct}%</td>
                  <td className="small dim wrap">{e.summary}</td>
                </tr>
              ))}
            {inducted.length === 0 && (
              <tr>
                <td colSpan={4} className="dim small">
                  Voting happens at the end of each year. A fighter becomes eligible two years after retiring.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="Leading candidates" flush>
        <table>
          <thead>
            <tr>
              <th>Fighter</th>
              <th>Retired</th>
              <th>Record</th>
              <th className="num">Case strength</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map(({ f, score }) => (
              <tr key={f.id}>
                <td>
                  <Link to={`/fighter/${f.id}`}>{f.name}</Link>
                </td>
                <td className="small">{f.retirementDate}</td>
                <td className="mono small">
                  {f.record.wins}-{f.record.losses}
                </td>
                <td className="num">
                  <Rating value={Math.min(99, score)} />
                </td>
              </tr>
            ))}
            {candidates.length === 0 && (
              <tr>
                <td colSpan={4} className="dim small">
                  No retired fighters yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function NewsPage() {
  const save = useGame((s) => s.save)!;
  const [minImportance, setMinImportance] = useState(1);
  const items = save.history.news.filter((n) => n.importance >= minImportance).slice(0, 400);

  return (
    <div className="page">
      <div className="page-head">
        <h1>News</h1>
        <span className="sub">{save.history.news.length} items</span>
      </div>
      <Panel flush>
        <div className="row" style={{ padding: 8 }}>
          <label>Minimum importance</label>
          <select value={minImportance} onChange={(e) => setMinImportance(Number(e.target.value))}>
            <option value={1}>Everything</option>
            <option value={2}>Notable and above</option>
            <option value={3}>Significant and above</option>
            <option value={4}>Major only</option>
            <option value={5}>Championship only</option>
          </select>
        </div>
        <table>
          <tbody>
            {items.map((n) => (
              <tr key={n.id}>
                <td className="dim small nowrap">{formatDate(n.date)}</td>
                <td className="wrap">
                  <strong>{n.headline}</strong>
                  <br />
                  <span className="small dim">{n.body}</span>
                </td>
                <td className="small">
                  {n.fighterIds.slice(0, 2).map((id) => (
                    <span key={id}>
                      <Link to={`/fighter/${id}`}>{save.fighters[id]?.name}</Link>{' '}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SettingsPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const showToast = useGame((s) => s.showToast);
  const persist = useGame((s) => s.persist);
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') ?? 'dark');

  const set = <K extends keyof typeof save.settings>(key: K, value: (typeof save.settings)[K]) => {
    mutate((s) => {
      s.settings[key] = value;
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        <span className="sub">{save.saveName}</span>
      </div>

      <div className="grid c2">
        <Panel title="Presentation">
          <div className="field">
            <label>Theme</label>
            <select
              value={theme}
              onChange={(e) => {
                setTheme(e.target.value);
                if (e.target.value === 'light') document.documentElement.setAttribute('data-theme', 'light');
                else document.documentElement.removeAttribute('data-theme');
                localStorage.setItem('octagon-theme', e.target.value);
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="field">
            <label>Live text speed</label>
            <select value={save.settings.simSpeed} onChange={(e) => set('simSpeed', e.target.value as 'slow' | 'normal' | 'fast')}>
              <option value="slow">Slow</option>
              <option value="normal">Normal</option>
              <option value="fast">Fast</option>
            </select>
          </div>
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.autoAdvanceStopsOnDecision} onChange={(e) => set('autoAdvanceStopsOnDecision', e.target.checked)} />
            <span className="small">Stop auto advance when a decision appears</span>
          </label>
        </Panel>

        <Panel title="Information">
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.revealRatings} onChange={(e) => set('revealRatings', e.target.checked)} />
            <span className="small">Reveal exact ratings for every fighter instead of scouted estimates</span>
          </label>
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.revealLiveScores} onChange={(e) => set('revealLiveScores', e.target.checked)} />
            <span className="small">Reveal exact judge scores during a fight</span>
          </label>
          <p className="small faint">
            Revealing ratings changes only what is displayed. The hidden state underneath is identical either way.
          </p>
        </Panel>

        <Panel title="Rules">
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.allowTenTen} onChange={(e) => set('allowTenTen', e.target.checked)} />
            <span className="small">Allow 10-10 rounds</span>
          </label>
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.allowTenSeven} onChange={(e) => set('allowTenSeven', e.target.checked)} />
            <span className="small">Allow 10-7 rounds</span>
          </label>
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.injuriesEnabled} onChange={(e) => set('injuriesEnabled', e.target.checked)} />
            <span className="small">Injuries enabled</span>
          </label>
          <label className="row tight mb">
            <input type="checkbox" checked={save.settings.retirementEnabled} onChange={(e) => set('retirementEnabled', e.target.checked)} />
            <span className="small">Retirements enabled</span>
          </label>
        </Panel>

        <Panel title="Simulation">
          <div className="field">
            <label>Difficulty</label>
            <select value={save.settings.difficulty} onChange={(e) => set('difficulty', e.target.value as typeof save.settings.difficulty)}>
              <option value="easy">Easy</option>
              <option value="normal">Normal</option>
              <option value="hard">Hard</option>
              <option value="brutal">Brutal</option>
            </select>
          </div>
          <div className="field">
            <label>Events per month</label>
            <input
              type="number"
              min={1}
              max={8}
              step={0.2}
              value={save.settings.eventsPerMonth}
              onChange={(e) => set('eventsPerMonth', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>Pot projection paths</label>
            <input type="number" min={20} max={400} step={10} value={save.settings.potPaths} onChange={(e) => set('potPaths', Number(e.target.value))} />
            <span className="small dim">
              More paths give a steadier Pot estimate and cost more time on the annual recalculation.
            </span>
          </div>
          <div className="field">
            <label>Pot percentile</label>
            <input
              type="number"
              min={0.5}
              max={0.95}
              step={0.01}
              value={save.settings.potPercentile}
              onChange={(e) => set('potPercentile', Number(e.target.value))}
            />
            <span className="small dim">
              Pot is the projected peak Ovr at this percentile across simulated development paths.
            </span>
          </div>
        </Panel>

        <Panel title="Save">
          <KeyValues
            rows={[
              ['Save name', save.saveName],
              ['Seed', save.seed],
              ['Schema version', save.schemaVersion],
              ['Created', save.createdAt.slice(0, 10)],
              ['Snapshot', save.snapshot.snapshotId],
              ['Size', `${(estimateSaveSize(save) / 1024 / 1024).toFixed(1)} MB`],
            ]}
          />
          <div className="row mt">
            <button onClick={() => downloadSave(save)}>Export to a file</button>
            <Link className="btn" to="/load">
              Manage saves
            </Link>
          </div>
          <p className="small faint mt">
            The same seed with the same decisions reproduces this world exactly.
          </p>
          <button
            className="mt"
            onClick={() => {
              // This used to show a success toast without writing anything, which is worse than
              // having no button: it told the player their world was safe when it was not.
              void persist().then(
                () => showToast('Saved.', 'good'),
                () => showToast('The save could not be written.', 'bad')
              );
            }}
          >
            Save now
          </button>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LoadGamePage() {
  const navigate = useNavigate();
  const setSave = useGame((s) => s.setSave);
  const current = useGame((s) => s.save);
  const [saves, setSaves] = useState<SaveIndexEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void listSaves().then(setSaves);
  useEffect(refresh, []);

  return (
    <div className="splash">
      <h1>Saves</h1>
      {error && <Notice kind="bad">{error}</Notice>}
      <Panel flush>
        <DataTable
          rows={saves}
          rowKey={(s) => s.saveId}
          initialSort="updatedAt"
          columns={[
            { key: 'name', label: 'Save', sort: (s) => s.saveName, render: (s) => s.saveName },
            { key: 'mode', label: 'Mode', sort: (s) => s.mode, render: (s) => s.mode },
            { key: 'who', label: 'Playing as', render: (s) => s.fighterName ?? s.gymName ?? 'Spectator' },
            { key: 'date', label: 'In game date', sort: (s) => s.date, render: (s) => formatDate(s.date) },
            { key: 'updatedAt', label: 'Last played', sort: (s) => s.updatedAt, render: (s) => s.updatedAt.slice(0, 16).replace('T', ' ') },
            { key: 'snapshot', label: 'Snapshot', render: (s) => <span className="small dim">{s.snapshotId}</span> },
            {
              key: 'actions',
              label: '',
              render: (s) => (
                <span className="row tight">
                  <button
                    className="small primary"
                    onClick={async () => {
                      try {
                        const loaded = await loadGame(s.saveId);
                        if (loaded) {
                          setSave(loaded);
                          navigate('/dashboard');
                        }
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Load
                  </button>
                  <button
                    className="small"
                    onClick={async () => {
                      const loaded = await loadGame(s.saveId);
                      if (loaded) downloadSave(loaded);
                    }}
                  >
                    Export
                  </button>
                  <button
                    className="small danger"
                    onClick={async () => {
                      // Dropped first, or clearing the loaded save flushes a queued write that
                      // puts the deleted career straight back.
                      discardPendingSave(s.saveId);
                      await deleteSave(s.saveId);
                      if (current?.saveId === s.saveId) setSave(null);
                      refresh();
                    }}
                  >
                    Delete
                  </button>
                </span>
              ),
            },
          ]}
          empty="No saves yet."
        />
      </Panel>

      <div className="row">
        <button className="primary" onClick={() => navigate('/new')}>
          New career
        </button>
        <label className="btn">
          Import a save file
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const imported = await importSaveFromFile(file);
                setSave(imported);
                navigate('/dashboard');
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </label>
        {current && (
          <button onClick={() => navigate('/dashboard')}>Back to the current save</button>
        )}
      </div>

      <p className="small faint mt">
        Saves live in this browser's IndexedDB storage. Export a file to move a career between machines.{' '}
        {migrationNotes(0).length} schema migration{migrationNotes(0).length === 1 ? '' : 's'} are available for older
        saves.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DataPage() {
  const save = useGame((s) => s.save)!;
  const meta = save.snapshot;
  const real = Object.values(save.fighters).filter((f) => f.isRealPerson).length;
  const fictional = Object.values(save.fighters).filter((f) => !f.isRealPerson).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Data and sources</h1>
        <span className="sub">Snapshot {meta.snapshotId}</span>
      </div>

      <Notice>{meta.note}</Notice>

      <div className="grid c2">
        <Panel title="Sources">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Records</th>
                <th>Fetched</th>
              </tr>
            </thead>
            <tbody>
              {meta.sources.map((s) => (
                <tr key={s.name}>
                  <td>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.name}
                    </a>
                  </td>
                  <td className="num">{s.recordCount}</td>
                  <td className="small dim">{s.fetchedAt?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small faint mt">
            The crawler honours the source's robots directives, including its crawl delay, and refuses the paths the
            site disallows. That is why the real roster is the officially ranked roster rather than the full historical
            athlete directory.
          </p>
        </Panel>

        <Panel title="What is real and what is not">
          <KeyValues
            rows={[
              ['Real athletes in this save', real],
              ['Fictional fighters', fictional],
              ['Snapshot captured', meta.snapshotDate],
              ['World date', formatDate(save.date)],
              ['Fights simulated', Object.keys(save.history.results).length],
            ]}
          />
          <h3 className="mt">Value kinds</h3>
          <ul className="small" style={{ paddingLeft: 16 }}>
            <li>
              <strong>Sourced fact.</strong> Name, nickname, height, reach, leg reach, listed weight, age, place of
              birth, professional record, activity status, gym affiliation, octagon debut and official ranking.
            </li>
            <li>
              <strong>Derived rating.</strong> The six performance ratings, produced by a documented model from the
              published rate statistics plus official standing. These are game ratings, never official measurements.
            </li>
            <li>
              <strong>Model estimate.</strong> Pot, Longevity, wear components, popularity, tendencies and style labels.
            </li>
            <li>
              <strong>Simulated.</strong> Every contract, purse, camp, injury, fight and result. Nothing simulated is
              ever written back into the snapshot.
            </li>
            <li>
              <strong>Unknown.</strong> Anything the source did not publish, including exact dates of birth. These are
              shown as Unknown and were not invented.
            </li>
          </ul>
        </Panel>

        <Panel title="Validation report">
          <KeyValues
            rows={[
              ['Total fighters in snapshot', meta.validation.totalFighters],
              ['Real fighters', meta.validation.realFighters],
              ['Duplicates resolved', meta.validation.duplicatesResolved.length],
              ['Warnings', meta.validation.warnings.length],
            ]}
          />
          <h3 className="mt">Fighters by division</h3>
          <table>
            <tbody>
              {Object.entries(meta.fighterCountByDivision).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Missing fields in the source">
          <p className="small dim">
            Counts of fighters for whom the source did not publish a value. These are recorded as gaps, never filled in.
          </p>
          <table>
            <tbody>
              {Object.entries(meta.validation.missingFieldCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="num">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {meta.validation.warnings.length > 0 && (
            <>
              <h3 className="mt">Warnings</h3>
              <ul className="small dim" style={{ paddingLeft: 16 }}>
                {meta.validation.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function HelpPage() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Help</h1>
      </div>

      <div className="grid c2">
        <Panel title="The six ratings">
          <p className="small">
            Every fighter has exactly six visible performance ratings on a 0 to 100 scale: Striking, Grappling,
            Wrestling, Submissions, Cardio and Durability. There is no seventh rating. Speed, power, chin, fight IQ,
            takedown defense and every other commonly requested attribute is an emergent product of those six combined
            with physicals, style tendencies and fight state.
          </p>
          <ul className="small" style={{ paddingLeft: 16 }}>
            <li>
              <strong>Ovr</strong> is the plain arithmetic mean of the six. It is never weighted and never adjusted for
              record, ranking, popularity or championship status.
            </li>
            <li>
              <strong>Pot</strong> is the projected peak Ovr. It is produced by running the development model forward
              many times and taking an optimistic percentile. It is not a skill and it does not pull ratings upward. A
              fighter can fall short of it or pass it.
            </li>
            <li>
              <strong>Longevity</strong> is remaining career resilience. It is never part of Ovr. It falls with damage,
              hard camps, severe weight cuts and age, and it only partly recovers with rest.
            </li>
          </ul>
        </Panel>

        <Panel title="Rating scale">
          <table>
            <tbody>
              {[
                ['95 to 100', 'Historically exceptional'],
                ['90 to 94', 'Dominant championship quality'],
                ['85 to 89', 'Elite champion or leading contender'],
                ['80 to 84', 'Strong ranked contender'],
                ['75 to 79', 'Ranked quality'],
                ['70 to 74', 'Established promotional quality'],
                ['65 to 69', 'Competitive lower roster'],
                ['60 to 64', 'Fringe roster quality'],
                ['50 to 59', 'Regional professional level'],
                ['40 to 49', 'Developing professional'],
                ['Below 40', 'Highly limited professional skill'],
              ].map(([band, meaning]) => (
                <tr key={band}>
                  <td className="mono">{band}</td>
                  <td className="small dim">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Scouting">
          <p className="small">
            You see exact ratings for fighters you control. Everyone else is shown an estimate with an uncertainty band.
            Better scouting narrows the band; it never moves the hidden value underneath, so a fighter does not get
            better or worse because you looked at them more closely.
          </p>
        </Panel>

        <Panel title="Advancing time">
          <p className="small">
            The advance controls at the top of every page move the world forward. The leftmost button is context aware:
            it becomes answering a decision, going to a weigh in, or entering the fight. Auto advance stops whenever a
            decision needs an answer.
          </p>
        </Panel>

        <Panel title="Determinism">
          <p className="small">
            Every random outcome comes from a seeded generator stored in the save. The same seed with the same decisions
            reproduces the same world, the same cards, and the same fights event for event. The seed for any individual
            fight is shown on its statistics tab.
          </p>
        </Panel>

        <Panel title="Divisions">
          <table>
            <tbody>
              {DIVISIONS.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td className="num mono">{d.limitLb} lb</td>
                  <td className="small dim">
                    non title bouts at {d.limitLb + d.nonTitleAllowanceLb} lb
                    {d.nonTitleAllowanceLb === 0 ? ' (no allowance)' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
