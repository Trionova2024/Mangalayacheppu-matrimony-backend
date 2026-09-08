/**
 * Utility for Date of Birth (DOB) validation and exact age calculation.
 * Business rule: Age must be between 18 and 100 years inclusive.
 */

/**
 * Validates day, month, and year for calendar validity and calculates exact age.
 * @param {string|number} dobDay 
 * @param {string|number} dobMonth 
 * @param {string|number} dobYear 
 * @param {Date} [refDate=new Date()] Optional reference date (defaults to current server date)
 * @returns {{ valid: boolean, age?: number, error?: string }}
 */
function validateAndCalculateAge(dobDay, dobMonth, dobYear, refDate = new Date()) {
  if (dobDay === undefined || dobDay === null || dobDay === "" ||
      dobMonth === undefined || dobMonth === null || dobMonth === "" ||
      dobYear === undefined || dobYear === null || dobYear === "") {
    return { valid: false, error: "Day, month, and year are required for date of birth" };
  }

  const d = Number(dobDay);
  const m = Number(dobMonth);
  const y = Number(dobYear);

  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) {
    return { valid: false, error: "Invalid date of birth format" };
  }

  if (m < 1 || m > 12) {
    return { valid: false, error: "Month must be between 1 and 12" };
  }

  const currentYear = refDate.getFullYear();
  if (y < 1900) {
    return { valid: false, error: "Year must be at least 1900" };
  }
  if (y > currentYear) {
    return { valid: false, error: "Date of birth cannot be in the future" };
  }

  // Days in given month (m is 1-indexed, day 0 of m is the last day of month m in UTC)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) {
    return { valid: false, error: `Invalid day ${d} for month ${m}/${y}` };
  }

  const birthDate = new Date(Date.UTC(y, m - 1, d));
  const today = new Date(Date.UTC(refDate.getFullYear(), refDate.getMonth(), refDate.getDate()));

  if (birthDate > today) {
    return { valid: false, error: "Date of birth cannot be in the future" };
  }

  // Calculate age using current date
  let age = refDate.getFullYear() - y;
  const monthDiff = refDate.getMonth() - (m - 1);
  if (monthDiff < 0 || (monthDiff === 0 && refDate.getDate() < d)) {
    age--;
  }

  // Enforce Matrimony business rule: 18 through 100
  if (age < 18) {
    return { valid: false, error: "Age must be at least 18 years" };
  }

  if (age > 100) {
    return { valid: false, error: "Age cannot exceed 100 years" };
  }

  return { valid: true, age };
}

/**
 * Safe helper to get age from DOB with fallback to existing stored age.
 * Does not throw; returns fallback if DOB is missing or invalid.
 */
function getAgeFromDob(dobDay, dobMonth, dobYear, fallbackAge = null, refDate = new Date()) {
  if (!dobDay || !dobMonth || !dobYear) {
    return fallbackAge;
  }
  const result = validateAndCalculateAge(dobDay, dobMonth, dobYear, refDate);
  if (result.valid) {
    return result.age;
  }
  return fallbackAge;
}

module.exports = {
  validateAndCalculateAge,
  getAgeFromDob,
};
