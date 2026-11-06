use std::sync::Arc;

use s3::Bucket;

use crate::bus::Bus;
use crate::db::Db;
use crate::instance::Instance;
use crate::limits::Limits;
use crate::ws::Hub;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub hub: Hub,
    pub s3: Option<Arc<Bucket>>,
    pub bus: Option<Bus>,
    reader: Db,
    pub instance: Arc<Instance>,
    pub limits: Arc<Limits>,
}

impl AppState {
    pub fn new(
        db: Db,
        hub: Hub,
        s3: Option<Arc<Bucket>>,
        bus: Option<Bus>,
        instance: Arc<Instance>,
    ) -> AppState {
        let reader = crate::db::reader(&db);
        let limits = Arc::new(Limits::default());
        AppState {
            db,
            hub,
            s3,
            bus,
            reader,
            instance,
            limits: limits.clone(),
        }
        .with_limits(limits)
    }

    /// The same state under `limits`. Its hub also takes their realtime part; the last state
    /// built on a hub sets the hub's limits.
    pub fn with_limits(self, limits: Arc<Limits>) -> AppState {
        self.hub.set_limits(limits.ws_limits());
        AppState { limits, ..self }
    }

    pub fn read(&self) -> Db {
        self.reader.clone()
    }

    /// The same state reading from `reader`, standing in for a replica behind the primary.
    #[cfg(test)]
    pub fn with_reader(self, reader: Db) -> AppState {
        AppState { reader, ..self }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::AppState;
    use crate::api::test_util::{done, temp_state};
    use crate::limits::Limits;

    #[tokio::test]
    async fn the_hub_takes_the_state_limits_and_the_pool_keeps_none() {
        let (state, path) = temp_state("state_limits").await;
        let limits = Arc::new(Limits {
            guest_grant_days: 2,
            voice_room_max: 3,
            ws_sockets_per_ip: 7,
            ..Limits::default()
        });
        let state = state.with_limits(limits.clone());
        assert_eq!(state.hub.limits(), limits.ws_limits());
        assert_eq!(state.hub.limits().voice_room_max, 3);
        let fresh = AppState::new(
            state.db.clone(),
            state.hub.clone(),
            None,
            None,
            state.instance.clone(),
        );
        assert_eq!(*fresh.limits, Limits::default());
        assert_eq!(fresh.hub.limits(), Limits::default().ws_limits());
        assert_eq!(state.limits, limits, "the first state keeps its own");
        done(fresh, path).await;
    }
}
