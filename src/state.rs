use std::sync::Arc;

use s3::Bucket;

use crate::bus::Bus;
use crate::db::Db;
use crate::ws::Hub;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub hub: Hub,
    pub s3: Option<Arc<Bucket>>,
    pub bus: Option<Bus>,
    reader: Db,
}

impl AppState {
    pub fn new(db: Db, hub: Hub, s3: Option<Arc<Bucket>>, bus: Option<Bus>) -> AppState {
        let reader = crate::db::reader(&db);
        AppState {
            db,
            hub,
            s3,
            bus,
            reader,
        }
    }

    pub fn read(&self) -> Db {
        self.reader.clone()
    }
}
