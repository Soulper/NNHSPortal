<?php
// ================================================================
// ENROLLMENT HELPERS — shared by Admin Users, Enrollments, Classes
// ================================================================

// Parse CSV upload (handles quoted fields, commas, newlines)
function parse_enrollment_csv($file) {
    if (!isset($file) || $file['error'] !== UPLOAD_ERR_OK) {
        return ['rows' => [], 'error' => 'No file uploaded or upload error.'];
    }
    if ($file['size'] > 2 * 1024 * 1024) {
        return ['rows' => [], 'error' => 'File too large (max 2MB).'];
    }
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    if (!in_array($ext, ['csv'], true)) {
        return ['rows' => [], 'error' => 'File must be a .csv'];
    }

    $handle = fopen($file['tmp_name'], 'r');
    if (!$handle) {
        return ['rows' => [], 'error' => 'Could not read file.'];
    }

    $headers = fgetcsv($handle);
    if (!$headers) {
        fclose($handle);
        return ['rows' => [], 'error' => 'Empty CSV.'];
    }
    $headers = array_map('strtolower', array_map('trim', $headers));

    $rows = [];
    $line = 1;
    while (($data = fgetcsv($handle)) !== false) {
        $line++;
        if (array_filter($data) === []) continue; // skip empty lines
        $row = array_combine($headers, $data);
        $row['_line'] = $line;
        $rows[] = $row;
    }
    fclose($handle);
    return ['rows' => $rows, 'error' => ''];
}

// Generate secure random password (12 chars: upper, lower, digit, symbol)
function generate_password($length = 12) {
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    $lower = 'abcdefghijkmnpqrstuvwxyz';
    $digits = '23456789';
    $symbols = '!@#$%^&*';
    $all = $upper . $lower . $digits . $symbols;
    $pwd = '';
    $pwd .= $upper[random_int(0, strlen($upper) - 1)];
    $pwd .= $lower[random_int(0, strlen($lower) - 1)];
    $pwd .= $digits[random_int(0, strlen($digits) - 1)];
    $pwd .= $symbols[random_int(0, strlen($symbols) - 1)];
    for ($i = 4; $i < $length; $i++) {
        $pwd .= $all[random_int(0, strlen($all) - 1)];
    }
    return str_shuffle($pwd);
}

// Validate student CSV row
function validate_student_row($db, $row, $active_year_id, $seen_numbers, $seen_emails) {
    $errors = [];

    $student_number = trim($row['student_number'] ?? '');
    $full_name = trim($row['full_name'] ?? '');
    $email = trim($row['email'] ?? '');
    $section = trim($row['section'] ?? '');
    $password = isset($row['password']) ? trim($row['password']) : '';

    if (!$student_number) $errors[] = 'Missing student_number';
    elseif (!preg_match('/^[A-Za-z0-9\-]{1,50}$/', $student_number)) $errors[] = 'Invalid student_number format';
    elseif (isset($seen_numbers[$student_number])) $errors[] = 'Duplicate student_number in CSV';
    elseif ((int)$db->query("SELECT COUNT(*) FROM students WHERE student_number=" . $db->quote($student_number))->fetchColumn() > 0) $errors[] = 'student_number already exists';

    if (!$full_name) $errors[] = 'Missing full_name';
    elseif (strlen($full_name) > 100) $errors[] = 'full_name too long';

    if ($email) {
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) $errors[] = 'Invalid email';
        elseif (isset($seen_emails[$email])) $errors[] = 'Duplicate email in CSV';
        elseif ((int)$db->query("SELECT COUNT(*) FROM users WHERE email=" . $db->quote($email))->fetchColumn() > 0) $errors[] = 'Email already registered';
    }

    if (!$section) $errors[] = 'Missing section';
    elseif (!preg_match('/^[A-Za-z0-9\-]{1,20}$/', $section)) $errors[] = 'Invalid section format';

    // Check section has classes in active academic year
    if ($section && $active_year_id) {
        $cls = (int)$db->prepare("SELECT COUNT(*) FROM classes WHERE section=? AND academic_year_id=? AND status='active'");
        $cls->execute([$section, $active_year_id]);
        if ($cls->fetchColumn() === 0) {
            $errors[] = "Section '$section' has no active classes in the current academic year";
        }
    }

    if ($password && strlen($password) < 8) $errors[] = 'Password must be at least 8 characters';

    return $errors;
}

// Validate teacher CSV row
function validate_teacher_row($db, $row, $seen_numbers, $seen_emails) {
    $errors = [];

    $employee_number = trim($row['employee_number'] ?? '');
    $full_name = trim($row['full_name'] ?? '');
    $email = trim($row['email'] ?? '');
    $department = trim($row['department'] ?? '');
    $password = isset($row['password']) ? trim($row['password']) : '';

    if (!$employee_number) $errors[] = 'Missing employee_number';
    elseif (!preg_match('/^[A-Za-z0-9\-]{1,30}$/', $employee_number)) $errors[] = 'Invalid employee_number format';
    elseif (isset($seen_numbers[$employee_number])) $errors[] = 'Duplicate employee_number in CSV';
    elseif ((int)$db->query("SELECT COUNT(*) FROM teachers WHERE employee_number=" . $db->quote($employee_number))->fetchColumn() > 0) $errors[] = 'employee_number already exists';

    if (!$full_name) $errors[] = 'Missing full_name';
    elseif (strlen($full_name) > 100) $errors[] = 'full_name too long';

    if (!$email) $errors[] = 'Missing email';
    elseif (!filter_var($email, FILTER_VALIDATE_EMAIL)) $errors[] = 'Invalid email';
    elseif (isset($seen_emails[$email])) $errors[] = 'Duplicate email in CSV';
    elseif ((int)$db->query("SELECT COUNT(*) FROM users WHERE email=" . $db->quote($email))->fetchColumn() > 0) $errors[] = 'Email already registered';

    if ($password && strlen($password) < 8) $errors[] = 'Password must be at least 8 characters';

    return $errors;
}

// Create student account (user + student profile)
function create_student_account($db, $student_number, $full_name, $email, $section, $password = '') {
    $pwd = $password ?: generate_password();
    $hashed = password_hash($pwd, PASSWORD_DEFAULT);
    $status = setting($db, 'registration_mode', 'open') === 'approval' ? 'pending' : 'active';

    $db->prepare("INSERT INTO users (role, email, password, status) VALUES ('student', ?, ?, ?)")
        ->execute([$email ?: null, $hashed, $status]);
    $user_id = (int)$db->lastInsertId();

    $db->prepare("INSERT INTO students (user_id, student_number, full_name, section) VALUES (?, ?, ?, ?)")
        ->execute([$user_id, $student_number, $full_name, $section]);

    return ['user_id' => $user_id, 'password' => $pwd, 'status' => $status];
}

// Create teacher account (user + teacher profile)
function create_teacher_account($db, $employee_number, $full_name, $email, $department, $password = '') {
    $pwd = $password ?: generate_password();
    $hashed = password_hash($pwd, PASSWORD_DEFAULT);

    $db->prepare("INSERT INTO users (role, email, password, status) VALUES ('teacher', ?, ?, 'active')")
        ->execute([$email, $hashed]);
    $user_id = (int)$db->lastInsertId();

    $db->prepare("INSERT INTO teachers (user_id, employee_number, full_name, department, contact_email) VALUES (?, ?, ?, ?, ?)")
        ->execute([$user_id, $employee_number, $full_name, $department, $email]);

    return ['user_id' => $user_id, 'password' => $pwd];
}

// Enroll student in all active classes of their section for the active academic year
function enroll_student_in_section($db, $student_user_id, $section, $active_year_id) {
    $class_ids = $db->prepare("SELECT id FROM classes WHERE section=? AND academic_year_id=? AND status='active'");
    $class_ids->execute([$section, $active_year_id]);
    $ids = $class_ids->fetchAll(PDO::FETCH_COLUMN);

    $enrolled = 0;
    foreach ($ids as $cid) {
        $existing = $db->prepare("SELECT COUNT(*) FROM class_members WHERE class_id=? AND student_id=?");
        $existing->execute([$cid, $student_user_id]);
        if ($existing->fetchColumn() === 0) {
            $db->prepare("INSERT INTO class_members (class_id, student_id) VALUES (?, ?)")
                ->execute([$cid, $student_user_id]);
            $enrolled++;
        }
    }
    return $enrolled;
}

// Get active academic year ID
function get_active_year_id($db) {
    $yid = (int)setting($db, 'active_academic_year_id', '');
    if (!$yid) {
        $yid = (int)$db->query("SELECT id FROM academic_years WHERE is_active=1 LIMIT 1")->fetchColumn();
    }
    return $yid ?: 0;
}

// Build enrollment CSV template
function build_student_csv_template() {
    return "student_number,full_name,email,section,password\n2027-00001,\"Dela Cruz, Juan\",juan.dc@school.edu,G11-A,\n2027-00002,\"Garcia, Maria\",maria.g@school.edu,G11-A,\n";
}

function build_teacher_csv_template() {
    return "employee_number,full_name,email,department,password\nTCH-001,\"Reyes, Ana\",ana.reyes@school.edu,Mathematics,\nTCH-002,\"Santos, Carlo\",carlo.s@school.edu,Language,\n";
}

function build_class_csv_template() {
    return "subject,sections,teacher_email,policy_name\nGeneral Mathematics,\"G11-A,G11-B\",ana.reyes@school.edu,\"DO 015 SHS Academic Core\"\nFilipino,\"G11-A,G11-B\",carlo.s@school.edu,\"DO 015 SHS Academic Core\"\n";
}

// Find policy ID by name
function find_policy_id($db, $policy_name) {
    $q = $db->prepare("SELECT id FROM grading_policies WHERE name=? AND is_active=1");
    $q->execute([$policy_name]);
    return (int)$q->fetchColumn();
}

// Find teacher ID by email
function find_teacher_id_by_email($db, $email) {
    $q = $db->prepare("SELECT t.user_id FROM teachers t JOIN users u ON u.id=t.user_id WHERE u.email=? AND u.status='active'");
    $q->execute([$email]);
    return (int)$q->fetchColumn();
}

// Get all active classes for a section/year
function get_classes_for_section($db, $section, $year_id) {
    $q = $db->prepare("SELECT id, subject FROM classes WHERE section=? AND academic_year_id=? AND status='active' ORDER BY subject");
    $q->execute([$section, $year_id]);
    return $q->fetchAll(PDO::FETCH_ASSOC);
}

// Get students in a section not yet enrolled in any class of that section/year
function get_unenrolled_students_in_section($db, $section, $year_id) {
    // Students with this section
    $stu = $db->prepare("SELECT s.user_id, s.full_name, s.student_number FROM students s JOIN users u ON u.id=s.user_id WHERE s.section=? AND u.status='active'");
    $stu->execute([$section]);
    $all = $stu->fetchAll(PDO::FETCH_ASSOC);

    // Classes for this section/year
    $class_ids = $db->prepare("SELECT id FROM classes WHERE section=? AND academic_year_id=? AND status='active'");
    $class_ids->execute([$section, $year_id]);
    $cids = $class_ids->fetchAll(PDO::FETCH_COLUMN);
    if (!$cids) return [];

    // Already enrolled
    $placeholders = implode(',', array_fill(0, count($cids), '?'));
    $enr = $db->prepare("SELECT DISTINCT student_id FROM class_members WHERE class_id IN ($placeholders)");
    $enr->execute($cids);
    $enrolled_ids = array_flip($enr->fetchAll(PDO::FETCH_COLUMN));

    // Return unenrolled
    return array_filter($all, fn($s) => !isset($enrolled_ids[$s['user_id']]));
}