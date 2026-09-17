const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

function validateUuidOrError(id, label = 'id') {
    if (!isValidUuid(id)) {
        return { valid: false, error: `Invalid ${label}: must be a UUID` };
    }
    return { valid: true };
}

function requireUuid(paramName = 'id') {
    return (req, res, next) => {
        const value = req.params[paramName];
        const check = validateUuidOrError(value, paramName);
        if (!check.valid) {
            return res.status(400).json({ success: false, error: check.error });
        }
        next();
    };
}

module.exports = {
    isValidUuid,
    validateUuidOrError,
    requireUuid
};
