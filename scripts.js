// Global variables to track active scene and method
var activeMethodPill = null;
var activeScenePill = null;

// Initialize when the document is loaded
document.addEventListener('DOMContentLoaded', function () {
    // Get initial active pills
    activeMethodPill = document.querySelector('.new-method-pill.active');
    activeScenePill = document.querySelector('.new-scene-pill.active');

    // Initialize video player
    if (activeMethodPill && activeScenePill) {
        updateVideoPlayer(activeMethodPill, activeScenePill);
    }

    // Add event listener for video metadata loading only if video exists
    var mainVideo = document.getElementById("mainVideo");
    if (mainVideo) {
        mainVideo.addEventListener('loadedmetadata', function() {
            this.play();
            console.log(`Video Size: ${this.videoWidth}x${this.videoHeight}`);
            this.hidden = false;
        });
    }
});

// Main function to update video player
function updateVideoPlayer(methodPill, scenePill) {
    // Use current active pills if not provided
    methodPill = methodPill || activeMethodPill;
    scenePill = scenePill || activeScenePill;

    // Update active states
    if (activeMethodPill && methodPill !== activeMethodPill) {
        activeMethodPill.classList.remove("active");
    }
    if (activeScenePill && scenePill !== activeScenePill) {
        activeScenePill.classList.remove("active");
    }

    // Set new active pills
    activeMethodPill = methodPill;
    activeScenePill = scenePill;
    methodPill.classList.add("active");
    scenePill.classList.add("active");

    // Get scene and method values
    var scene = scenePill.getAttribute("data-scene");
    var method = methodPill.getAttribute("data-method");

    // Update video source
    var video = document.getElementById("mainVideo");
    if (video) {
        video.src = `assets/Normal_Waymo_Single_View/${scene}_${method}.mp4`;
        video.load();
        video.play().catch(function(error) {
            console.warn('Video play failed:', error);
        });
    }
} 