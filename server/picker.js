// server/picker.js — chooses the secret team for each new game.
//
// Plain random picking is fair on average but streaky: with four sports, "no NFL team in 10 games" happens
// about 5% of the time by pure luck, and players notice. This picker is still random, but it deals the sports
// out like a shuffled deck: every sport appears once per round of games (in random order), so no sport can
// go missing for more than 6 games in a row. Inside a sport it avoids teams used recently.
// Modes with a single sport (NCAA, UCL) just get the "no recent repeats" part.

import { randomInt } from "node:crypto";

export class TeamPicker {
    constructor(teamsByMode, rand = randomInt) {
        this.teamsByMode = teamsByMode;           // { pro: [...], ncaa: [...], ucl: [...] }
        this.rand = rand;                         // rand(n) -> a whole number from 0 to n-1 (replaceable in tests)
        this.state = new Map();                   // mode -> { bag: [sports still to deal], last: sport, recent: [team names] }
    }

    shuffle(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = this.rand(i + 1);
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    pick(mode) {
        const teams = this.teamsByMode[mode];
        const st = this.state.get(mode) || { bag: [], last: null, recent: [] };

        if (!st.bag.length) {                                  // a fresh deck: every sport once, in a random order
            const sports = this.shuffle([...new Set(teams.map(t => t.sport))]);
            if (sports.length > 1 && sports[0] === st.last) [sports[0], sports[1]] = [sports[1], sports[0]];   // never the same sport twice in a row
            st.bag = sports;
        }
        const sport = st.bag.shift();
        st.last = sport;

        const ofSport = teams.filter(t => t.sport === sport);
        let pool = ofSport.filter(t => !st.recent.includes(t.name));   // skip teams used in the last half-list of games
        if (!pool.length) pool = ofSport;
        const team = pool[this.rand(pool.length)];

        st.recent.push(team.name);
        if (st.recent.length > Math.floor(teams.length / 2)) st.recent.shift();
        this.state.set(mode, st);
        return team;
    }
}
