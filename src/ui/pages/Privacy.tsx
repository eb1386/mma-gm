import { GAME_NAME } from '@core/config/branding';
import { Panel } from '../components';

/**
 * Privacy.
 *
 * Written for a free browser game that stores everything locally. No advertising code is
 * present in this build; this page describes what would change if that ever alters.
 */
export function PrivacyPage() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Privacy</h1>
        <span className="sub">What this game stores and what it does not</span>
      </div>

      <Panel title="What is stored">
        <p>
          {GAME_NAME} runs entirely in your browser. Your careers are saved to your own device using IndexedDB. They are
          not uploaded anywhere, and there is no account, no login and no server that holds your saves.
        </p>
        <p>
          Deleting a career from the landing screen removes it from your device. Clearing your browser storage for this
          site removes every career.
        </p>
      </Panel>

      <Panel title="What is not collected">
        <ul>
          <li>No name, email address or account of any kind.</li>
          <li>No analytics or tracking scripts in this build.</li>
          <li>No advertising and no advertising identifiers in this build.</li>
          <li>No cookies are set by the game itself.</li>
        </ul>
      </Panel>

      <Panel title="If advertising is added later">
        <p>
          This is a free game and it may carry advertising in future. If that happens, this page will be updated before
          any advertising code ships, and it will name the provider and describe what that provider collects. Your saved
          careers would remain local to your device either way.
        </p>
      </Panel>

      <Panel title="Data about real people">
        <p>
          The game includes factual information about real athletes taken from a documented public source, with per
          field provenance shown on each fighter page. Nothing is invented to fill a gap: values the source does not
          publish are left unknown, or are clearly labelled as derived or simulated.
        </p>
        <p>
          Every contract, purse and business figure in the game is simulated. No real pay figure is presented as
          reported. Ratings are values produced by the game model and are not measurements of a real person.
        </p>
        <p>
          If you are represented in this game and want to be removed, the roster is rebuilt from a snapshot and an
          exclusion can be applied at that layer.
        </p>
      </Panel>
    </div>
  );
}
