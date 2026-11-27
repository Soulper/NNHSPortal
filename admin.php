<?php
// ================================================================
// SCHOOL PORTAL — ADMIN PANEL
// ================================================================
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/includes/admin.php';

require_admin();

$page = isset($_GET['page']) ? $_GET['page'] : 'overview';

// Handle template downloads (GET)
if (isset($_GET['download'])) {
    require_once __DIR__ . '/includes/enrollment_helpers.php';
    $type = $_GET['download'];
    if ($type === 'student_template') {
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="student_enrollment_template.csv"');
        echo build_student_csv_template();
        exit;
    } elseif ($type === 'teacher_template') {
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="teacher_template.csv"');
        echo build_teacher_csv_template();
        exit;
    } elseif ($type === 'class_template') {
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="class_builder_template.csv"');
        echo build_class_csv_template();
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_admin_post($db);
}

$school_name = setting($db, 'school_name', 'School Portal');

// Navbar identity chip data
$__chip_name = $_SESSION['full_name'] ?? 'Administrator';
$__chip_role = 'Administrator';
$__chip_parts = preg_split('/\s+/', trim(preg_replace('/[^A-Za-z ]/', '', $__chip_name)));
$__chip_ini = strtoupper(substr($__chip_parts[0] ?? 'A', 0, 1) . (isset($__chip_parts[1]) ? substr($__chip_parts[1], 0, 1) : ''));
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin Panel — <?= htmlspecialchars($school_name) ?></title>
    <link rel="icon" href="logo.ico" type="image/x-icon">
    <meta name="csrf-token" content="<?= htmlspecialchars(csrf_token()) ?>">
    <script>(function(){var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-bs-theme',t);})();</script>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&display=swap" rel="stylesheet">
    <link href="style.css" rel="stylesheet">
</head>
<body>

<nav class="navbar navbar-expand-lg navbar-dark app-navbar">
    <div class="container">
        <a class="navbar-brand fw-bold" href="admin.php"><img src="logo.ico" alt="School Portal" width="24" height="24" class="me-2">Admin Panel</a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
            <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarNav">
                        <ul class="navbar-nav ms-auto">
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'overview'."'".'?'active':'' ?>" href="admin.php">Overview</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'users'."'".'?'active':'' ?>" href="admin.php?page=users">Users</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'enrollments'."'".'?'active':'' ?>" href="admin.php?page=enrollments">Enrollments</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'classes'."'".'?'active':'' ?>" href="admin.php?page=classes">Classes</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'years'."'".'?'active':'' ?>" href="admin.php?page=years">Years & Terms</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'policies'."'".'?'active':'' ?>" href="admin.php?page=policies">Policies</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'calendar'."'".'?'active':'' ?>" href="admin.php?page=calendar">Calendar</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'announcements'."'".'?'active':'' ?>" href="admin.php?page=announcements">Announcements</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'audit'."'".'?'active':'' ?>" href="admin.php?page=audit">Audit Log</a></li>
                <li class="nav-item"><a class="nav-link <?= $page=='."'".'settings'."'".'?'active':'' ?>" href="admin.php?page=settings">Settings</a></li>
                <li class="nav-item"><a class="nav-link text-white-50" href="dashboard.php">Back to Portal</a></li>
            </ul>
        </div>
    </div>
</nav>

<div class="container mt-4">
    <?php
    if (isset($_SESSION['flash'])) {
        echo '<div class="alert alert-' . $_SESSION['flash_type'] . ' alert-dismissible fade show" role="alert">' . htmlspecialchars($_SESSION['flash']) . '<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>';
        unset($_SESSION['flash'], $_SESSION['flash_type']);
    }

    switch ($page) {
        case 'users': admin_users(); break;
        case 'enrollments': admin_enrollments(); break;
        case 'classes': admin_classes(); break;
        case 'years': admin_years(); break;
        case 'policies': admin_policies(); break;
        case 'calendar': admin_calendar(); break;
        case 'announcements': admin_announcements(); break;
        case 'audit': admin_audit(); break;
        case 'settings': admin_settings(); break;
        default: admin_overview();
    }
    ?>
</div>

<footer class="text-center text-muted py-3 mt-4 border-top">
    <small>&copy; <?= date('Y') ?> <?= htmlspecialchars($school_name) ?>. All rights reserved.</small>
</footer>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
<script src="script.js"></script>
<script src="theme.js"></script>
</body>
</html>






