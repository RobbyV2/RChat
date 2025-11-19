use std::sync::Arc;
use tower_governor::governor::GovernorConfigBuilder;

pub fn create_rate_limit_layer() -> tower_governor::GovernorLayer<'static> {
    let config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(100)
            .burst_size(20)
            .finish()
            .unwrap(),
    );

    tower_governor::GovernorLayer {
        config: Box::leak(Box::new(config)),
    }
}
