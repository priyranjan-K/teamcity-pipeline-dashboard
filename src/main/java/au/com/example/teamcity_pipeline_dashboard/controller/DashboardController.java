package au.com.example.teamcity_pipeline_dashboard.controller;

import au.com.example.teamcity_pipeline_dashboard.config.TeamCityProperties;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class DashboardController {

    private final TeamCityProperties properties;

    public DashboardController(TeamCityProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/")
    public String rootRedirect() {
        return "redirect:/status";
    }

    @GetMapping("/dashboard")
    public String index(Model model) {
        model.addAttribute("projects", properties.getProjects());
        model.addAttribute("teamcityUrl", properties.getUrl());
        return "dashboard";
    }

    @GetMapping("/status")
    public String status(Model model) {
        model.addAttribute("projects", properties.getProjects());
        model.addAttribute("teamcityUrl", properties.getUrl());
        return "status";
    }
}
