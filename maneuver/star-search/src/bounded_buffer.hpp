#ifndef STAR_SEARCH_BOUNDED_BUFFER_HPP
#define STAR_SEARCH_BOUNDED_BUFFER_HPP

#include "status.hpp"

#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <type_traits>
#include <utility>

namespace star_search {

constexpr std::size_t kWasmMaximumMemoryBytes = 2147483648ULL;

inline bool checked_add(std::size_t left, std::size_t right, std::size_t* out) {
    if (out == nullptr || left > std::numeric_limits<std::size_t>::max() - right) {
        return false;
    }
    *out = left + right;
    return true;
}

inline bool checked_multiply(std::size_t left, std::size_t right, std::size_t* out) {
    if (out == nullptr) {
        return false;
    }
    if (left != 0U && right > std::numeric_limits<std::size_t>::max() / left) {
        return false;
    }
    *out = left * right;
    return true;
}

class MemoryBudget {
  public:
    explicit MemoryBudget(std::size_t limit_bytes)
        : limit_bytes_(limit_bytes), live_bytes_(0U), peak_bytes_(0U) {}

    bool can_grow(std::size_t bytes) const {
        return bytes <= limit_bytes_ - (live_bytes_ <= limit_bytes_ ? live_bytes_ : limit_bytes_);
    }

    void commit_grow(std::size_t bytes) {
        live_bytes_ += bytes;
        if (live_bytes_ > peak_bytes_) {
            peak_bytes_ = live_bytes_;
        }
    }

    void release(std::size_t bytes) {
        live_bytes_ = bytes <= live_bytes_ ? live_bytes_ - bytes : 0U;
    }

    std::size_t limit_bytes() const { return limit_bytes_; }
    std::size_t live_bytes() const { return live_bytes_; }
    std::size_t peak_bytes() const { return peak_bytes_; }

  private:
    std::size_t limit_bytes_;
    std::size_t live_bytes_;
    std::size_t peak_bytes_;
};

template <typename T>
class Buffer {
    static_assert(std::is_trivially_copyable<T>::value, "Buffer requires trivially copyable rows");

  public:
    Buffer() : data_(nullptr), size_(0U), capacity_(0U), budget_(nullptr) {}
    ~Buffer() { reset(); }

    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;

    Buffer(Buffer&& other) noexcept
        : data_(other.data_),
          size_(other.size_),
          capacity_(other.capacity_),
          budget_(other.budget_) {
        other.data_ = nullptr;
        other.size_ = 0U;
        other.capacity_ = 0U;
        other.budget_ = nullptr;
    }

    Buffer& operator=(Buffer&& other) noexcept {
        if (this != &other) {
            reset();
            data_ = other.data_;
            size_ = other.size_;
            capacity_ = other.capacity_;
            budget_ = other.budget_;
            other.data_ = nullptr;
            other.size_ = 0U;
            other.capacity_ = 0U;
            other.budget_ = nullptr;
        }
        return *this;
    }

    Status reserve(std::size_t requested, MemoryBudget* budget) {
        if (requested <= capacity_) {
            return Status::Ok;
        }
        std::size_t new_bytes = 0U;
        std::size_t old_bytes = 0U;
        if (!checked_multiply(requested, sizeof(T), &new_bytes) ||
            !checked_multiply(capacity_, sizeof(T), &old_bytes)) {
            return Status::InvalidInput;
        }
        const std::size_t growth = new_bytes - old_bytes;
        MemoryBudget* selected = budget_ != nullptr ? budget_ : budget;
        if (selected == nullptr || !selected->can_grow(growth)) {
            return Status::MemoryLimitExceeded;
        }
        void* allocation = std::realloc(data_, new_bytes);
        if (allocation == nullptr) {
            return Status::AllocationFailed;
        }
        data_ = static_cast<T*>(allocation);
        capacity_ = requested;
        budget_ = selected;
        budget_->commit_grow(growth);
        return Status::Ok;
    }

    Status resize(std::size_t requested, MemoryBudget* budget) {
        Status status = reserve(requested, budget);
        if (status != Status::Ok) {
            return status;
        }
        if (requested > size_) {
            std::memset(data_ + size_, 0, (requested - size_) * sizeof(T));
        }
        size_ = requested;
        return Status::Ok;
    }

    Status push_back(const T& value, std::size_t row_cap, MemoryBudget* budget) {
        if (size_ >= row_cap) {
            return Status::RowLimitExceeded;
        }
        if (size_ == capacity_) {
            std::size_t next = capacity_ == 0U ? 64U : capacity_ + capacity_ / 2U;
            if (next <= capacity_) {
                return Status::InvalidInput;
            }
            if (next > row_cap) {
                next = row_cap;
            }
            Status status = reserve(next, budget);
            if (status != Status::Ok) {
                return status;
            }
        }
        data_[size_++] = value;
        return Status::Ok;
    }

    void clear() { size_ = 0U; }

    void reset() {
        if (data_ != nullptr) {
            std::size_t bytes = capacity_ * sizeof(T);
            std::free(data_);
            if (budget_ != nullptr) {
                budget_->release(bytes);
            }
        }
        data_ = nullptr;
        size_ = 0U;
        capacity_ = 0U;
        budget_ = nullptr;
    }

    T* data() { return data_; }
    const T* data() const { return data_; }
    std::size_t size() const { return size_; }
    std::size_t capacity() const { return capacity_; }
    bool empty() const { return size_ == 0U; }

    T& operator[](std::size_t index) { return data_[index]; }
    const T& operator[](std::size_t index) const { return data_[index]; }

  private:
    T* data_;
    std::size_t size_;
    std::size_t capacity_;
    MemoryBudget* budget_;
};

}  // namespace star_search

#endif
