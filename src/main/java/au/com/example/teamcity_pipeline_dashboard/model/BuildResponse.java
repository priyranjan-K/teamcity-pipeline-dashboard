package au.com.example.teamcity_pipeline_dashboard.model;

import lombok.Data;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

@Data
public class BuildResponse {
    private String id;
    private String buildTypeId;
    private String number;
    private String status; // SUCCESS, FAILURE, ERROR, UNKNOWN
    private String state;  // queued, running, finished
    private String branchName;
    private String href;
    private String webUrl;
    private Integer percentageComplete;
    private String statusText;
    private Long waitEstimate; // in seconds
    private Long duration; // in seconds
    private String startEstimate; // ISO-8601 string
    private Map<String, Object> properties;

    @JsonProperty("running-info")
    private RunningInfo runningInfo;

    private String startDate;
    private String finishDate;
    private CanceledInfo canceledInfo;
    
    private TriggeredInfo triggered;
    private String triggeredBy;

    @Data
    public static class RunningInfo {
        private Long percentageComplete;
        private Long elapsedSeconds;
        private Long leftSeconds;
        private Long estimatedTotalSeconds;
        private String currentStageText;
    }

    @Data
    public static class CanceledInfo {
        private String timestamp;
        private String comment;
        private UserInfo user;
    }

    @Data
    public static class TriggeredInfo {
        private String type; // user, vcs, schedule, etc.
        private String details;
        private UserInfo user;
    }

    @Data
    public static class UserInfo {
        private String username;
        private String name;
    }
}
