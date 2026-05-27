-- Add referral_code to users table
ALTER TABLE users ADD COLUMN referral_code VARCHAR(20) UNIQUE;

-- Add referred_by_id to users table (foreign key to users.id)
ALTER TABLE users ADD COLUMN referred_by_id INTEGER REFERENCES users(id);

-- Add referral_earnings_total for tracking earnings
ALTER TABLE users ADD COLUMN referral_earnings_total DECIMAL(12, 2) DEFAULT 0.00;

-- Optional: Create an index on referral_code for faster lookups
CREATE INDEX idx_users_referral_code ON users (referral_code);

-- Optional: Create an index on referred_by_id
CREATE INDEX idx_users_referred_by_id ON users (referred_by_id);
