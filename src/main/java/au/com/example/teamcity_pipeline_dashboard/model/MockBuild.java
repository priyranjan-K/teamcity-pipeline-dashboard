package au.com.example.teamcity_pipeline_dashboard.model;

import lombok.Data;
import java.time.Instant;

@Data
public class MockBuild {
    private String id;
    private String buildTypeId;
    private String number;
    private String status;
    private String state;
    private String branchName;
    private String environment;
    private Instant triggerTime;
    private Instant startTime;
    private Instant endTime;
    private int durationSeconds;
    private int queueSeconds;
    private boolean isDeploy;
    private String buildNumber;
}
