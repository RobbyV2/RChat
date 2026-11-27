//! Permission rules shared by the server and by P2P devices: the bit registry, the masks, the
//! channel evaluator, the hierarchy, escalation checks, role order and the category-sync check.

pub mod delta;
pub mod eval;
pub mod hier;
pub mod masks;
pub mod order;
pub mod registry;
pub mod rules;
pub mod sync;

/// A permission mask in canonical (hosted) values. Every value is below 2^53.
pub type Mask = u64;
