//! Time for the cue engine (B3): `Date.now()`, `setTimeout` and `setInterval` as `cueManager.js`
//! uses them, as one injectable clock. Real time in the app; a fake clock that only moves when
//! told in the differential check (`rust/scripts/drive-data.js` has the same fake for Node).

use std::sync::{Arc, Mutex};

use crate::core::jsv;

/// What a timer does when it fires: the two timers the cue manager sets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimerKind {
    /// `_schedulePersistWorkspace`'s debounced save (`setTimeout`).
    SaveDebounce,
    /// `_startPlaybackTimeBroadcast`'s `playback-time-update` tick (`setInterval`, 100 ms).
    PlaybackTime,
}

#[derive(Clone, Debug)]
struct Timer {
    id: u64,
    due: f64,
    interval: Option<f64>,
    kind: TimerKind,
}

pub struct Clock {
    /// The fake clock's time, shared with whatever else reads it (the fake engine).
    fake: Option<Arc<Mutex<f64>>>,
    start: f64,
    timers: Vec<Timer>,
    seq: u64,
}

impl Clock {
    /// Real time: `now()` is the system clock.
    pub fn real() -> Self {
        Clock {
            fake: None,
            start: jsv::now_ms(),
            timers: Vec::new(),
            seq: 0,
        }
    }

    /// A clock that starts at `start` ms and moves only through `set_now`.
    pub fn fake(start: f64) -> Self {
        Clock {
            fake: Some(Arc::new(Mutex::new(start))),
            start,
            timers: Vec::new(),
            seq: 0,
        }
    }

    /// `Date.now()`.
    pub fn now(&self) -> f64 {
        match &self.fake {
            Some(t) => t.lock().map_or(f64::NAN, |t| *t),
            None => jsv::now_ms(),
        }
    }

    /// The fake clock's shared time (`None` for real time).
    pub fn shared(&self) -> Option<Arc<Mutex<f64>>> {
        self.fake.clone()
    }

    pub fn is_fake(&self) -> bool {
        self.fake.is_some()
    }

    pub fn set_now(&mut self, now: f64) {
        if let Some(t) = &self.fake
            && let Ok(mut t) = t.lock()
        {
            *t = now;
        }
    }

    fn add(&mut self, kind: TimerKind, ms: f64, interval: Option<f64>) -> u64 {
        self.seq += 1;
        let ms = if ms.is_nan() { 0.0 } else { ms.max(0.0) };
        self.timers.push(Timer {
            id: self.seq,
            due: self.now() + ms,
            interval,
            kind,
        });
        self.seq
    }

    /// `setTimeout(fn, ms)`.
    pub fn set_timeout(&mut self, kind: TimerKind, ms: f64) -> u64 {
        self.add(kind, ms, None)
    }

    /// `setInterval(fn, ms)`.
    pub fn set_interval(&mut self, kind: TimerKind, ms: f64) -> u64 {
        self.add(kind, ms, Some(ms.max(1.0)))
    }

    /// `clearTimeout` / `clearInterval`.
    pub fn clear(&mut self, id: u64) {
        self.timers.retain(|t| t.id != id);
    }

    /// The next timer due at or before `until`, in (due, creation) order: moves the clock to it,
    /// reschedules an interval or drops a timeout, and returns what to run.
    pub fn take_due(&mut self, until: f64) -> Option<TimerKind> {
        let i = self
            .timers
            .iter()
            .enumerate()
            .filter(|(_, t)| t.due <= until)
            .min_by(|(_, a), (_, b)| a.due.total_cmp(&b.due).then(a.id.cmp(&b.id)))
            .map(|(i, _)| i)?;
        let due = self.timers[i].due;
        self.set_now(due);
        let kind = self.timers[i].kind;
        match self.timers[i].interval {
            Some(every) => self.timers[i].due += every,
            None => {
                self.timers.remove(i);
            }
        }
        Some(kind)
    }

    /// Pending timers relative to the start, for the differential check's state output.
    pub fn pending(&self) -> Vec<(f64, Option<f64>)> {
        let mut out: Vec<(f64, Option<f64>)> = self
            .timers
            .iter()
            .map(|t| (t.due - self.start, t.interval))
            .collect();
        out.sort_by(|a, b| a.0.total_cmp(&b.0));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timers_fire_in_due_then_creation_order_and_intervals_repeat() {
        let mut c = Clock::fake(1000.0);
        let save = c.set_timeout(TimerKind::SaveDebounce, 300.0);
        c.set_interval(TimerKind::PlaybackTime, 100.0);
        c.clear(save);
        c.set_timeout(TimerKind::SaveDebounce, 200.0);
        let mut fired = Vec::new();
        while let Some(k) = c.take_due(1300.0) {
            fired.push((k, c.now() - 1000.0));
        }
        // 200 ms: the interval (created first) before the timeout due at the same time.
        assert_eq!(
            fired,
            vec![
                (TimerKind::PlaybackTime, 100.0),
                (TimerKind::PlaybackTime, 200.0),
                (TimerKind::SaveDebounce, 200.0),
                (TimerKind::PlaybackTime, 300.0),
            ]
        );
        assert_eq!(c.pending(), vec![(400.0, Some(100.0))]);
    }

    #[test]
    fn negative_and_nan_delays_are_zero() {
        let mut c = Clock::fake(0.0);
        c.set_timeout(TimerKind::SaveDebounce, -5.0);
        c.set_timeout(TimerKind::SaveDebounce, f64::NAN);
        assert_eq!(c.pending(), vec![(0.0, None), (0.0, None)]);
    }
}
