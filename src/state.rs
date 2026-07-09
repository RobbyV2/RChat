use std::sync::Arc;

use s3::Bucket;

use crate::db::Db;
use crate::ws::Hub;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub hub: Hub,
    pub s3: Option<Arc<Bucket>>,
}
