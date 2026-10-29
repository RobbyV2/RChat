use std::sync::Arc;

use s3::Bucket;

use crate::bus::Bus;
use crate::db::Db;
use crate::instance::Instance;
use crate::ws::Hub;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub hub: Hub,
    pub s3: Option<Arc<Bucket>>,
    pub bus: Option<Bus>,
    reader: Db,
    pub instance: Arc<Instance>,
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
        AppState {
            db,
            hub,
            s3,
            bus,
            reader,
            instance,
        }
    }

    pub fn read(&self) -> Db {
        self.reader.clone()
    }
}
