//! A field of a "changes" object that may be left alone, cleared, or set.
//!
//! The TypeScript editing functions tell these apart with `"field" in changes`:
//! an absent key keeps the current value, while a key present as `null` clears it.
//! Over JSON that is the difference between a missing field and a `null` one.

use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, PartialEq)]
pub enum Patch<T> {
    /// The key was not sent: keep the current value.
    Absent,
    /// The key was sent as `null`: clear the value.
    Null,
    Value(T),
}

impl<T> Default for Patch<T> {
    fn default() -> Self {
        Self::Absent
    }
}

impl<T> Patch<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    /// The value when one was sent; `None` for both an absent and a `null` key.
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Value(value) => Some(value),
            _ => None,
        }
    }
}

// Serde calls this only for a key that is present, so `null` is a deliberate clear.
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}
