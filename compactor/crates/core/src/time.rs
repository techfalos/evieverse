//! Times. Every timestamp is UTC epoch milliseconds, as in src/time.ts.

/// A minute, in milliseconds.
pub const MINUTE: i64 = 60 * 1000;
/// An hour, in milliseconds: what turns the settings given in hours into a time.
pub const HOUR: i64 = 60 * MINUTE;
/// A day, in milliseconds: what a UTC day number counts, and what turns the settings given in
/// days into a time.
pub const DAY: i64 = 24 * HOUR;

/// The UTC day number of a time: the whole days since the epoch, counted down for a time
/// before it, as `Math.floor(ms / DAY)` counts them.
pub fn utc_day(ms: i64) -> i64 {
    ms.div_euclid(DAY)
}

/// A time cut to the whole seconds day indexes keep.
pub fn whole_seconds(ms: i64) -> i64 {
    ms.div_euclid(1000) * 1000
}

/// The clock a process tells the time by: the system's, or the one a test gives it.
pub type Clock = std::sync::Arc<dyn Fn() -> i64 + Send + Sync>;

/// The time now by the system's clock, in UTC epoch milliseconds.
pub fn system_now() -> i64 {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

/// The system's clock, in UTC epoch milliseconds.
pub fn system_clock() -> Clock {
    std::sync::Arc::new(system_now)
}

/// A clock that stands at one time: what a caller that tells the time itself gives.
pub fn fixed_clock(ms: i64) -> Clock {
    std::sync::Arc::new(move || ms)
}

/// A time as the API writes one for people and other programs (`Date.toISOString()`):
/// `2026-11-06T12:00:00.000Z`.
pub fn iso(ms: i64) -> String {
    let (days, of_day) = (ms.div_euclid(DAY), ms.rem_euclid(DAY));
    // The civil date of a day number (Howard Hinnant's algorithm), with years counted from March.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let (hours, minutes, seconds, millis) = (of_day / HOUR, of_day % HOUR / MINUTE, of_day % MINUTE / 1000, of_day % 1000);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_days_and_seconds_down_before_the_epoch() {
        assert_eq!(utc_day(0), 0);
        assert_eq!(utc_day(DAY - 1), 0);
        assert_eq!(utc_day(DAY), 1);
        assert_eq!(utc_day(-1), -1);
        assert_eq!(whole_seconds(1999), 1000);
        assert_eq!(whole_seconds(-1), -1000);
    }

    #[test]
    fn writes_a_time_as_the_api_does() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_793_966_400_000), "2026-11-06T12:00:00.000Z");
        assert_eq!(iso(951_782_399_999), "2000-02-28T23:59:59.999Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso(-1), "1969-12-31T23:59:59.999Z");
    }
}
